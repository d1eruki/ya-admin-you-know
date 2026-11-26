import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

interface Env {
  DB: D1Database;
  LOCAL_TEST_BRIDGE?: string;
  DRAFT_MEDIA?: R2Bucket;
  GITHUB_PUBLISH_TOKEN?: string;
  PUBLISH_WORKFLOW_SECRET?: string;
  PUBLISH_REPOSITORY?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  AUTH_SECRET?: string;
  ALLOWED_ORIGINS: string;
}

interface Site {
  address: string;
  name: string;
  email: string;
}

interface Challenge {
  id: string;
  code_hash: string;
}

const codeLifetime = 600_000;
const resendDelay = 60_000;
const sessionLifetime = 8 * 60 * 60_000;
const requestWindow = 600_000;
const maxBodyBytes = 2048;
const encoder = new TextEncoder();

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function hex(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function unhex(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function codeKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function setupSecret(env: Env) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    throw new RequestError(503, "Настройка входа ещё не завершена.");
  }
  return env.AUTH_SECRET;
}

function randomCode() {
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values);
  while (values[0] >= 4_294_000_000);
  return String(values[0] % 1_000_000).padStart(6, "0");
}

function normalizeAddress(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    return "";
  try {
    const raw = value.trim();
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.replace(/\.$/, "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ||
      url.port ||
      url.username ||
      url.password
    )
      return "";

    const pathname = url.pathname.replace(/\/+$/, "");
    return `https://${host}${pathname}/`;
  } catch {
    return "";
  }
}

async function readBody(
  request: Request,
  limit = maxBodyBytes,
): Promise<Record<string, unknown>> {
  if (
    !request.headers.get("Content-Type")?.startsWith("application/json") ||
    !request.body
  ) {
    throw new RequestError(400, "Проверьте данные запроса.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RequestError(413, "Данные запроса слишком большие.");
    }
    text += decoder.decode(value, { stream: true });
  }

  try {
    const body: unknown = JSON.parse(text + decoder.decode());
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Use the same response for invalid JSON and unexpected body shapes.
  }
  throw new RequestError(400, "Проверьте данные запроса.");
}

function publicSite(site: Site) {
  return {
    domain: site.address.replace(/^https:\/\//, "").replace(/\/$/, ""),
    name: site.name,
    url: site.address,
  };
}

async function limitCodeRequests(
  request: Request,
  env: Env,
  secret: string,
  now: number,
) {
  const client = request.headers.get("CF-Connecting-IP") ?? "unavailable";
  const clientHash = hex(
    await crypto.subtle.sign(
      "HMAC",
      await codeKey(secret),
      encoder.encode(`client:${client}`),
    ),
  );
  const limit = await env.DB.prepare(
    `INSERT INTO login_request_limits (client_hash, window_start, requests)
     VALUES (?, ?, 1)
     ON CONFLICT(client_hash) DO UPDATE SET
       requests = CASE WHEN window_start <= ? THEN 1 ELSE requests + 1 END,
       window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
     WHERE window_start <= ? OR requests < 10
     RETURNING requests`,
  )
    .bind(
      clientHash,
      now,
      now - requestWindow,
      now - requestWindow,
      now - requestWindow,
    )
    .first();
  if (!limit)
    throw new RequestError(429, "Слишком много запросов. Попробуйте позже.");
}

function localBridge(env: Env) {
  return env.LOCAL_TEST_BRIDGE === "http://127.0.0.1:8790"
    ? env.LOCAL_TEST_BRIDGE
    : null;
}

async function requestCode(request: Request, env: Env, revoke = false) {
  const session = revoke ? await getSession(request, env) : null;
  if (revoke && !session)
    throw new RequestError(401, "Войдите в админку ещё раз.");
  const table = revoke ? "session_revocation_challenges" : "login_challenges";
  const secret = setupSecret(env);
  const { address } = await readBody(request);
  const canonical = session?.url ?? normalizeAddress(address);
  if (!canonical) throw new RequestError(400, "Укажите полный адрес сайта.");
  const now = Date.now();
  await limitCodeRequests(request, env, secret, now);

  const site = await env.DB.prepare(
    "SELECT address, name, email FROM sites WHERE address = ?",
  )
    .bind(canonical)
    .first<Site>();
  const challengeId = crypto.randomUUID();
  if (!site) return json({ challengeId }, 202);
  if (!env.MAIL_FROM || !env.RESEND_API_KEY)
    throw new RequestError(503, "Отправка кодов ещё не настроена.");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "DELETE FROM login_request_limits WHERE window_start <= ?",
    ).bind(now - 86_400_000),
  ]);

  const code = randomCode();
  const codeHash = hex(
    await crypto.subtle.sign(
      "HMAC",
      await codeKey(secret),
      encoder.encode(`${revoke ? "revoke:" : ""}${challengeId}:${code}`),
    ),
  );
  const saved = await env.DB.prepare(
    `INSERT INTO ${table} (site_address, id, code_hash, sent_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(site_address) DO UPDATE SET
       id = excluded.id, code_hash = excluded.code_hash, sent_at = excluded.sent_at,
       expires_at = excluded.expires_at, attempts = 0
     WHERE sent_at <= ?
     RETURNING id`,
  )
    .bind(
      site.address,
      challengeId,
      codeHash,
      now,
      now + codeLifetime,
      now - resendDelay,
    )
    .first();
  if (!saved)
    throw new RequestError(
      429,
      "Код уже запрошен. Проверьте почту или попробуйте через минуту.",
    );

  try {
    const bridge = localBridge(env);
    const action = revoke ? "отзыва всех сессий" : "входа";
    const delivery = await fetch(
      bridge ? bridge + "/mail" : "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `login/${challengeId}`,
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [site.email],
          subject: `Код ${action} в ya-admin-you-know`,
          text: `Код ${action}: ${code}\nСайт: ${site.address}\nКод действует 10 минут.`,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = (await delivery.json()) as { id?: string };
    if (!delivery.ok || !result.id)
      throw new Error("Resend did not accept the message.");
  } catch {
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`)
      .bind(challengeId)
      .run();
    throw new RequestError(503, "Не удалось отправить код. Попробуйте позже.");
  }

  return json({ challengeId }, 202);
}

async function verifyCode(request: Request, env: Env, revoke = false) {
  const session = revoke ? await getSession(request, env) : null;
  if (revoke && !session)
    throw new RequestError(401, "Войдите в админку ещё раз.");
  const table = revoke ? "session_revocation_challenges" : "login_challenges";
  const secret = setupSecret(env);
  const { address, challengeId, code } = await readBody(request);
  const canonical = session?.url ?? normalizeAddress(address);
  if (
    !canonical ||
    typeof challengeId !== "string" ||
    challengeId.length !== 36 ||
    typeof code !== "string" ||
    !/^\d{6}$/.test(code)
  ) {
    throw new RequestError(400, "Введите шестизначный код.");
  }

  const now = Date.now();
  const invalidCode = new RequestError(
    401,
    "Код не подошёл или истёк. Проверьте письмо или запросите новый код.",
  );
  const challenge = await env.DB.prepare(
    `UPDATE ${table}
     SET attempts = attempts + 1
     WHERE site_address = ? AND id = ? AND expires_at > ? AND attempts < 5
     RETURNING id, code_hash`,
  )
    .bind(canonical, challengeId, now)
    .first<Challenge>();
  if (!challenge) throw invalidCode;
  const matches = await crypto.subtle.verify(
    "HMAC",
    await codeKey(secret),
    unhex(challenge.code_hash),
    encoder.encode(`${revoke ? "revoke:" : ""}${challenge.id}:${code}`),
  );
  if (!matches) throw invalidCode;

  if (revoke) {
    const tokenHash = await sessionTokenHash(request);
    const now = Date.now();
    const [revoked] = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM sessions WHERE site_address = ?
        AND EXISTS (SELECT 1 FROM session_revocation_challenges WHERE site_address = ? AND id = ? AND expires_at > ?)
        AND EXISTS (SELECT 1 FROM sessions WHERE site_address = ? AND token_hash = ? AND expires_at > ?)`,
      ).bind(canonical, canonical, challengeId, now, canonical, tokenHash, now),
      env.DB.prepare(
        `DELETE FROM login_challenges WHERE site_address = ?
        AND EXISTS (SELECT 1 FROM session_revocation_challenges WHERE site_address = ? AND id = ? AND expires_at > ?)`,
      ).bind(canonical, canonical, challengeId, now),
      env.DB.prepare(
        "DELETE FROM session_revocation_challenges WHERE site_address = ? AND id = ?",
      ).bind(canonical, challengeId),
    ]);
    if (!revoked.meta.changes) throw invalidCode;
    return new Response(null, { status: 204 });
  }

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const issuedAt = Date.now();
  const [created, , lookup] = await env.DB.batch<Site>([
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, site_address, expires_at)
       SELECT ?, site_address, ? FROM login_challenges
       WHERE site_address = ? AND id = ? AND expires_at > ?`,
    ).bind(
      tokenHash,
      issuedAt + sessionLifetime,
      canonical,
      challengeId,
      issuedAt,
    ),
    env.DB.prepare(
      "DELETE FROM login_challenges WHERE site_address = ? AND id = ?",
    ).bind(canonical, challengeId),
    env.DB.prepare(
      "SELECT address, name, email FROM sites WHERE address = ?",
    ).bind(canonical),
  ]);
  const site = lookup.results[0];
  if (created.meta.changes !== 1 || !site) throw invalidCode;
  return json({ site: publicSite(site), token });
}

async function sessionTokenHash(request: Request) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
  return token ? sha256(token) : null;
}

async function getSession(request: Request, env: Env) {
  const tokenHash = await sessionTokenHash(request);
  if (!tokenHash) return null;
  const site = await env.DB.prepare(
    `SELECT sites.address, sites.name, sites.email
     FROM sessions JOIN sites ON sites.address = sessions.site_address
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(tokenHash, Date.now())
    .first<Site>();
  return site ? publicSite(site) : null;
}

interface ContentSource {
  repository: string;
  source_ref: string;
  publish_ref: string | null;
}

interface ContentField {
  key: string;
  section: string;
  group: string;
  label: string;
  type: "text" | "image";
  value: string;
}

interface Draft {
  revision: number;
  edits: string;
  base_values: string;
}

function isContentField(value: unknown): value is ContentField {
  if (!value || typeof value !== "object") return false;
  const field = value as Partial<ContentField>;
  return (
    typeof field.key === "string" &&
    field.key.length > 0 &&
    typeof field.section === "string" &&
    field.section.length > 0 &&
    typeof field.group === "string" &&
    field.group.length > 0 &&
    typeof field.label === "string" &&
    field.label.length > 0 &&
    typeof field.value === "string" &&
    (field.type === "text" || field.type === "image")
  );
}

async function loadManifest(
  env: Env,
  source: ContentSource,
  publicationId?: string,
) {
  const unavailable = new RequestError(
    502,
    "Не удалось загрузить поля сайта из GitHub. Попробуйте ещё раз.",
  );
  if (
    !/^[\w-]+\/[\w.-]+$/.test(source.repository) ||
    !source.source_ref
      .split("/")
      .every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")
  )
    throw unavailable;

  const bridge = localBridge(env);
  const base = bridge
    ? bridge + "/content/" + source.source_ref + "/"
    : "https://raw.githubusercontent.com/" +
      source.repository +
      "/refs/heads/" +
      source.source_ref +
      "/";
  let raw: string;
  let manifest: { schemaVersion?: number; fields?: unknown };
  try {
    const response = await fetch(
      base +
        "content-manifest.json" +
        (publicationId ? "?published=" + publicationId : ""),
      {
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok)
      throw new Error(`GitHub responded with ${response.status}`);
    raw = await response.text();
    manifest = JSON.parse(raw);
  } catch (error) {
    console.error("Could not fetch the content manifest", error);
    throw unavailable;
  }

  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.fields) ||
    !manifest.fields.every(isContentField)
  )
    throw unavailable;

  const keys = new Set<string>();
  const baseValues = new Map<string, string>();
  const fields: ContentField[] = [];
  for (const {
    key,
    section,
    group,
    label,
    type,
    value,
  } of manifest.fields as ContentField[]) {
    if (
      keys.has(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    )
      throw unavailable;
    keys.add(key);
    baseValues.set(key, value);
    if (type === "image") {
      const parts = value.split("/");
      if (
        parts.some((part) => !part || part === "." || part === "..") ||
        !/\.(?:avif|jpe?g|png|webp)$/i.test(value)
      )
        throw unavailable;
      fields.push({
        key,
        section,
        group,
        label,
        type,
        value: base + parts.map(encodeURIComponent).join("/"),
      });
    } else {
      fields.push({ key, section, group, label, type, value });
    }
  }

  return { fields, baseValues, manifestRevision: await sha256(raw) };
}

type PublicationStatus = "queued" | "running" | "succeeded" | "failed";

interface Publication {
  id: string;
  site_address: string;
  draft_revision: number;
  target_ref: string;
  payload: string;
  workflow_run: string | null;
  status: PublicationStatus;
  message: string;
}

const maxImageBytes = 4 * 1024 * 1024;
const mediaIdPattern = /^[a-f0-9-]{36}\.(?:png|jpg|webp)$/;
const publicationIdPattern = /^[a-f0-9-]{36}$/;
const publicationTimeout = 45 * 60_000;
const revisionConflict = () =>
  new RequestError(
    409,
    "Поля или черновик изменились. Скопируйте свои правки перед обновлением страницы.",
  );

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "Проверьте поля черновика.");
  return value as Record<string, unknown>;
}

function getMediaBucket(env: Env) {
  if (!env.DRAFT_MEDIA)
    throw new RequestError(503, "Хранилище изображений ещё не подключено.");
  return env.DRAFT_MEDIA;
}

async function mediaKey(address: string, id: string) {
  return (await sha256(address)) + "/" + id;
}

function detectImage(bytes: Uint8Array) {
  const invalid = () =>
    new RequestError(
      400,
      "Выберите целое изображение JPG, PNG или WebP без анимации.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, value: string) =>
    Array.from(value).every(
      (char, index) => bytes[at + index] === char.charCodeAt(0),
    );
  const has = (at: number, signature: number[]) =>
    signature.every((byte, index) => bytes[at + index] === byte);
  const size = (
    width: number,
    height: number,
    extension: string,
    contentType: string,
  ) => {
    if (
      width < 1 ||
      height < 1 ||
      width > 4096 ||
      height > 4096 ||
      width * height > 16_000_000
    )
      throw new RequestError(
        400,
        "Изображение должно быть до 4096 пикселей на сторону и до 16 мегапикселей.",
      );
    return { extension, contentType };
  };

  if (
    bytes.length >= 45 &&
    has(0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    view.getUint32(8) === 13 &&
    tag(12, "IHDR")
  ) {
    const result = size(
      view.getUint32(16),
      view.getUint32(20),
      "png",
      "image/png",
    );
    let data = false;
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at);
      const end = at + length + 12;
      if (end > bytes.length || tag(at + 4, "acTL")) throw invalid();
      if (length && tag(at + 4, "IDAT")) data = true;
      if (tag(at + 4, "IEND")) {
        if (!data || length !== 0 || end !== bytes.length) throw invalid();
        return result;
      }
      at = end;
    }
  } else if (
    bytes.length >= 15 &&
    has(0, [255, 216, 255]) &&
    has(bytes.length - 2, [255, 217])
  ) {
    let dimensions: ReturnType<typeof size> | undefined;
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 255) throw invalid();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (at + 2 > bytes.length) throw invalid();
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) throw invalid();
      if ([192, 193, 194].includes(marker) && length >= 8) {
        dimensions = size(
          view.getUint16(at + 5),
          view.getUint16(at + 3),
          "jpg",
          "image/jpeg",
        );
      }
      if (marker === 218 && dimensions && at + length < bytes.length - 2)
        return dimensions;
      at += length;
    }
  } else if (
    bytes.length >= 25 &&
    tag(0, "RIFF") &&
    tag(8, "WEBP") &&
    view.getUint32(4, true) === bytes.length - 8
  ) {
    let canvasWidth = 0;
    let canvasHeight = 0;
    let width = 0;
    let height = 0;
    let at = 12;
    const u24 = (offset: number) =>
      bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    for (; at + 8 <= bytes.length;) {
      const length = view.getUint32(at + 4, true);
      const data = at + 8;
      const end = data + length + (length % 2);
      if (end > bytes.length || tag(at, "ANIM") || tag(at, "ANMF"))
        throw invalid();
      if (tag(at, "VP8X") && length === 10) {
        if (bytes[data] & 2) throw invalid();
        canvasWidth = 1 + u24(data + 4);
        canvasHeight = 1 + u24(data + 7);
      }
      if (tag(at, "VP8 ") && length >= 10 && has(data + 3, [157, 1, 42])) {
        if (width) throw invalid();
        width = view.getUint16(data + 6, true) & 0x3fff;
        height = view.getUint16(data + 8, true) & 0x3fff;
      } else if (tag(at, "VP8L") && length >= 5 && bytes[data] === 47) {
        if (width) throw invalid();
        const dimensions = view.getUint32(data + 1, true);
        width = 1 + (dimensions & 0x3fff);
        height = 1 + ((dimensions >>> 14) & 0x3fff);
      }
      at = end;
    }
    if (
      at === bytes.length &&
      width &&
      (!canvasWidth || (canvasWidth === width && canvasHeight === height))
    )
      return size(width, height, "webp", "image/webp");
  }
  throw invalid();
}

const uploadWindow = 60 * 60_000;
const unusedUploadLifetime = 24 * uploadWindow;

async function cleanUnusedUploads(env: Env) {
  if (!env.DRAFT_MEDIA) return;
  const bucket = env.DRAFT_MEDIA;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `UPDATE site_media_uploads SET state = 'deleting' WHERE id IN (
       SELECT upload.id FROM site_media_uploads AS upload
       WHERE upload.state = 'deleting'
          OR (upload.state = 'pending' AND upload.created_at < ?)
          OR (upload.state = 'ready' AND upload.created_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM site_content_drafts AS draft, json_each(draft.edits) AS edit
               WHERE draft.site_address = upload.site_address AND edit.value = upload.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM site_content_publications AS pub, json_each(pub.payload, '$.changes') AS change
               WHERE pub.site_address = upload.site_address AND pub.status IN ('queued', 'running')
                 AND json_extract(change.value, '$.type') = 'image' AND json_extract(change.value, '$.value') = upload.id
             ))
       LIMIT 100
     ) RETURNING id, site_address`,
  )
    .bind(now - uploadWindow, now - unusedUploadLifetime)
    .all<{ id: string; site_address: string }>();
  if (!results.length) return;
  await bucket.delete(
    await Promise.all(
      results.map(({ id, site_address }) => mediaKey(site_address, id)),
    ),
  );
  await env.DB.batch(
    results.map(({ id }) =>
      env.DB.prepare(
        "DELETE FROM site_media_uploads WHERE id = ? AND state = 'deleting'",
      ).bind(id),
    ),
  );
}

async function draftMedia(request: Request, env: Env, id?: string) {
  const site = await getSession(request, env);
  if (!site) throw new RequestError(401, "Войдите в админку ещё раз.");
  const bucket = getMediaBucket(env);
  if (id) {
    const owned = await env.DB.prepare(
      "SELECT id FROM site_media_uploads WHERE id = ? AND site_address = ? AND state = 'ready'",
    )
      .bind(id, site.url)
      .first();
    if (!owned) throw new RequestError(404, "Изображение не найдено.");
    return mediaResponse(bucket, site.url, id);
  }

  if (!request.body) throw new RequestError(400, "Выберите изображение.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxImageBytes) {
      await reader.cancel();
      throw new RequestError(413, "Размер изображения должен быть до 4 МБ.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const { extension, contentType } = detectImage(bytes);
  const imageId = crypto.randomUUID() + "." + extension;
  const now = Date.now();
  const reservation = await env.DB.prepare(
    `INSERT INTO site_media_uploads (id, site_address, created_at, state)
     SELECT ?, ?, ?, 'pending'
     WHERE (SELECT count(*) FROM site_media_uploads WHERE site_address = ? AND created_at > ?) < 20
       AND (SELECT count(*) FROM site_media_uploads WHERE site_address = ?) < 200`,
  )
    .bind(imageId, site.url, now, site.url, now - uploadWindow, site.url)
    .run();
  if (!reservation.meta.changes)
    throw new RequestError(
      429,
      "Лимит загрузок сайта исчерпан. Попробуйте позже.",
    );

  const key = await mediaKey(site.url, imageId);
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
    const ready = await env.DB.prepare(
      "UPDATE site_media_uploads SET state = 'ready' WHERE id = ? AND state = 'pending'",
    )
      .bind(imageId)
      .run();
    if (!ready.meta.changes) throw new Error("Upload reservation expired");
  } catch (error) {
    await env.DB.prepare(
      "UPDATE site_media_uploads SET state = 'deleting' WHERE id = ?",
    )
      .bind(imageId)
      .run();
    await bucket.delete(key);
    throw error;
  }
  return json({ id: imageId }, 201);
}

async function mediaResponse(bucket: R2Bucket, address: string, id: string) {
  if (!mediaIdPattern.test(id))
    throw new RequestError(404, "Изображение не найдено.");
  const object = await bucket.get(await mediaKey(address, id));
  if (!object) throw new RequestError(404, "Изображение не найдено.");
  return new Response(object.body as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type":
        object.httpMetadata?.contentType ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function latestPublication(env: Env, address: string) {
  await env.DB.prepare(
    "UPDATE site_content_publications SET status = 'failed', message = 'Время ожидания выкладки истекло.' WHERE site_address = ? AND status IN ('queued', 'running') AND created_at < ?",
  )
    .bind(address, Date.now() - publicationTimeout)
    .run();
  return env.DB.prepare(
    "SELECT id, status, message FROM site_content_publications WHERE site_address = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(address)
    .first<Pick<Publication, "id" | "status" | "message">>();
}

function canPublish(env: Env, source: ContentSource) {
  return Boolean(
    env.GITHUB_PUBLISH_TOKEN &&
    env.PUBLISH_WORKFLOW_SECRET &&
    env.PUBLISH_REPOSITORY === source.repository &&
    source.publish_ref &&
    source.source_ref === source.publish_ref,
  );
}

async function startPublication(
  env: Env,
  address: string,
  source: ContentSource,
  stored: Draft,
  edits: Record<string, string>,
  base: Record<string, unknown>,
  fields: ContentField[],
) {
  if (!canPublish(env, source))
    throw new RequestError(
      503,
      "Публикация для этого сайта ещё не подключена.",
    );
  const changes = fields.flatMap(({ key, type }) =>
    Object.hasOwn(edits, key)
      ? [{ key, type, value: edits[key], expected: base[key] }]
      : [],
  );
  if (!changes.length)
    throw new RequestError(400, "В черновике нет изменений.");
  if (
    changes.length !== Object.keys(edits).length ||
    changes.some(({ expected }) => typeof expected !== "string")
  )
    throw revisionConflict();

  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO site_content_publications (id, site_address, draft_revision, repository, target_ref, payload, status, created_at)
     SELECT ?, site_address, revision, ?, ?, ?, 'queued', ? FROM site_content_drafts
     WHERE site_address = ? AND revision = ? AND NOT EXISTS (
       SELECT 1 FROM site_content_publications WHERE site_address = ? AND status IN ('queued', 'running')
     )`,
  )
    .bind(
      id,
      source.repository,
      source.publish_ref,
      JSON.stringify({ changes }),
      Date.now(),
      address,
      stored.revision,
      address,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new RequestError(
      409,
      "Публикация уже запущена или черновик изменился.",
    );

  let response: Response;
  try {
    response = await fetch(
      localBridge(env)
        ? localBridge(env) + "/dispatch"
        : `https://api.github.com/repos/${source.repository}/actions/workflows/publish-admin-content.yml/dispatches`,
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${env.GITHUB_PUBLISH_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          "User-Agent": "ya-admin-you-know",
        },
        body: JSON.stringify({
          ref: source.publish_ref,
          inputs: { publication: id },
        }),
      },
    );
  } catch {
    // An interrupted response can still mean GitHub accepted the run.
    return json({ id, status: "queued", message: "" }, 202);
  }
  if (response.status >= 400 && response.status < 500) {
    await env.DB.prepare(
      "UPDATE site_content_publications SET status = 'failed', message = 'GitHub отклонил запуск выкладки.' WHERE id = ? AND status = 'queued'",
    )
      .bind(id)
      .run();
    throw new RequestError(
      502,
      "GitHub отклонил запуск выкладки. Черновик сохранён.",
    );
  }
  return json({ id, status: "queued", message: "" }, 202);
}

async function workflowPublication(
  request: Request,
  env: Env,
  id: string,
  mediaId?: string,
) {
  const secret = env.PUBLISH_WORKFLOW_SECRET;
  const supplied = request.headers.get("Authorization") ?? "";
  if (!secret || secret.length < 32 || supplied.length > 512)
    throw new RequestError(401, "Требуется доступ GitHub Actions.");
  const key = await codeKey(secret);
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode("Bearer " + secret),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      expected,
      encoder.encode(supplied),
    ))
  )
    throw new RequestError(401, "Требуется доступ GitHub Actions.");

  const run = request.headers.get("X-Publication-Run") ?? "";
  if (!/^\d{1,24}$/.test(run))
    throw new RequestError(400, "Не указан запуск GitHub Actions.");

  const job = await env.DB.prepare(
    "SELECT id, site_address, draft_revision, target_ref, payload, status, message, workflow_run FROM site_content_publications WHERE id = ? AND repository = ?",
  )
    .bind(id, env.PUBLISH_REPOSITORY ?? "")
    .first<Publication>();
  if (!job) throw new RequestError(404, "Публикация не найдена.");
  if (job.workflow_run !== null && job.workflow_run !== run)
    throw new RequestError(409, "Публикация уже выполняется в другом запуске.");
  const payload = JSON.parse(job.payload) as {
    changes: { type: string; value: string }[];
  };

  if (request.method === "GET") {
    if (job.status !== "queued" && job.status !== "running")
      throw new RequestError(409, "Публикация уже завершена.");
    if (mediaId) {
      if (job.status !== "running" || job.workflow_run !== run)
        throw new RequestError(409, "Публикация ещё не запущена.");
      if (
        !payload.changes.some(
          ({ type, value }) => type === "image" && value === mediaId,
        )
      )
        throw new RequestError(404, "Изображение не найдено.");
      return mediaResponse(getMediaBucket(env), job.site_address, mediaId);
    }
    const claim = await env.DB.prepare(
      "UPDATE site_content_publications SET status = 'running', workflow_run = ? WHERE id = ? AND (status = 'queued' OR (status = 'running' AND workflow_run = ?))",
    )
      .bind(run, id, run)
      .run();
    if (claim.meta.changes !== 1)
      throw new RequestError(409, "Публикация уже выполняется.");
    return json({ targetRef: job.target_ref, ...payload });
  }

  if (mediaId) throw new RequestError(404, "Запрос не поддерживается.");
  const { status, reason } = await readBody(request);
  if (status !== "succeeded" && status !== "failed")
    throw new RequestError(400, "Проверьте статус публикации.");

  if (
    status === "succeeded" &&
    (job.status !== "running" || job.workflow_run !== run)
  ) {
    if (job.status === "succeeded" && job.workflow_run === run)
      return json({ status });
    throw new RequestError(409, "Публикация ещё не запущена.");
  }
  const message =
    status === "succeeded"
      ? "Опубликовано."
      : reason === "conflict"
        ? "Поля на сайте изменились. Черновик сохранён."
        : "Выкладка не завершилась. Черновик сохранён.";
  const finish = env.DB.prepare(
    "UPDATE site_content_publications SET status = ?, message = ?, workflow_run = ? WHERE id = ? AND (status = 'queued' OR (status = 'running' AND workflow_run = ?))",
  ).bind(status, message, run, id, run);
  if (status === "succeeded") {
    await env.DB.batch([
      finish,
      env.DB.prepare(
        `UPDATE site_content_drafts SET revision = revision + 1, edits = '{}', base_values = '{}'
         WHERE site_address = ? AND revision = ? AND EXISTS (
           SELECT 1 FROM site_content_publications WHERE id = ? AND status = 'succeeded'
         )`,
      ).bind(job.site_address, job.draft_revision, id),
    ]);
  } else {
    await finish.run();
  }
  return json({ status });
}

async function siteContent(
  request: Request,
  env: Env,
  operation: "content" | "draft" | "publish" | "status",
) {
  const site = await getSession(request, env);
  if (!site) throw new RequestError(401, "Войдите в админку ещё раз.");
  const source = await env.DB.prepare(
    "SELECT repository, source_ref, publish_ref FROM site_content_sources WHERE site_address = ?",
  )
    .bind(site.url)
    .first<ContentSource>();
  if (!source) throw new RequestError(404, "Поля сайта ещё не подключены.");
  const publication = await latestPublication(env, site.url);
  if (operation === "status") return json({ publication });

  const published = await env.DB.prepare(
    "SELECT id FROM site_content_publications WHERE site_address = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(site.url)
    .first<{ id: string }>();
  const { fields, baseValues, manifestRevision } = await loadManifest(
    env,
    source,
    published?.id,
  );
  const fieldTypes = new Map(fields.map(({ key, type }) => [key, type]));
  const stored = await env.DB.prepare(
    "SELECT revision, edits, base_values FROM site_content_drafts WHERE site_address = ?",
  )
    .bind(site.url)
    .first<Draft>();
  const currentRevision = stored?.revision ?? 0;
  const revision = `${manifestRevision}:${currentRevision}`;
  const edits = (stored ? JSON.parse(stored.edits) : {}) as Record<
    string,
    string
  >;
  const previousBase = asRecord(stored ? JSON.parse(stored.base_values) : {});
  const publishingEnabled = canPublish(env, source);
  const mediaEnabled = Boolean(env.DRAFT_MEDIA);
  const needsBaseline = Object.keys(edits).some(
    (key) => typeof previousBase[key] !== "string",
  );

  if (operation === "content") {
    const draft = Object.fromEntries(
      Object.entries(edits).filter(([key]) => fieldTypes.has(key)),
    );
    return json({
      fields,
      draft,
      revision,
      publication,
      publishingEnabled,
      mediaEnabled,
      needsBaseline,
    });
  }

  if (publication?.status === "queued" || publication?.status === "running")
    throw new RequestError(409, "Дождитесь окончания публикации.");
  const body = await readBody(request, 256 * 1024);
  if (body.revision !== revision) throw revisionConflict();

  if (operation === "publish") {
    if (!stored) throw new RequestError(400, "Сначала сохраните черновик.");
    return startPublication(
      env,
      site.url,
      source,
      stored,
      edits,
      previousBase,
      fields,
    );
  }

  const changed = new Map<string, string>();
  const attachmentIds: string[] = [];
  const base = new Map<string, string>();
  for (const [key, value] of Object.entries(asRecord(body.edits))) {
    const type = fieldTypes.get(key);
    const baseline = baseValues.get(key);
    if (!type || typeof value !== "string" || baseline === undefined)
      throw new RequestError(400, "Проверьте значения полей черновика.");
    if (value === baseline) continue;
    if (
      type === "image" &&
      (!mediaIdPattern.test(value) ||
        !(await getMediaBucket(env).head(await mediaKey(site.url, value))))
    )
      throw new RequestError(400, "Изображение черновика не найдено.");

    if (type === "image") attachmentIds.push(value);
    changed.set(key, value);
    const savedBase = previousBase[key];
    base.set(key, typeof savedBase === "string" ? savedBase : baseline);
  }
  for (const key of Object.keys(edits)) {
    if (!fieldTypes.has(key)) throw revisionConflict();
  }
  const draft = Object.fromEntries(changed);
  const nextRevision = currentRevision + 1;
  const values = JSON.stringify(Object.fromEntries(base));
  const readyAttachments = `NOT EXISTS (
    SELECT 1 FROM json_each(?) AS attachment
    WHERE NOT EXISTS (
      SELECT 1 FROM site_media_uploads WHERE id = attachment.value AND site_address = ? AND state = 'ready'
    )
  )`;
  const attachments = JSON.stringify(attachmentIds);
  const statement = stored
    ? env.DB.prepare(
        `UPDATE site_content_drafts SET revision = ?, edits = ?, base_values = ?
         WHERE site_address = ? AND revision = ? AND NOT EXISTS (
           SELECT 1 FROM site_content_publications WHERE site_address = ? AND status IN ('queued', 'running')
         ) AND ${readyAttachments}`,
      ).bind(
        nextRevision,
        JSON.stringify(draft),
        values,
        site.url,
        currentRevision,
        site.url,
        attachments,
        site.url,
      )
    : env.DB.prepare(
        `INSERT INTO site_content_drafts (revision, edits, base_values, site_address)
         SELECT ?, ?, ?, ? WHERE ${readyAttachments} ON CONFLICT(site_address) DO NOTHING`,
      ).bind(
        nextRevision,
        JSON.stringify(draft),
        values,
        site.url,
        attachments,
        site.url,
      );
  if ((await statement.run()).meta.changes !== 1) throw revisionConflict();
  return json({
    fields,
    draft,
    revision: `${manifestRevision}:${nextRevision}`,
    publication,
    publishingEnabled,
    mediaEnabled,
    needsBaseline: false,
  });
}

async function handle(request: Request, env: Env) {
  const pathname = new URL(request.url).pathname;
  if (
    pathname === "/api/local/ready" &&
    request.method === "GET" &&
    localBridge(env) &&
    request.headers.get("Authorization") === "Bearer " + env.RESEND_API_KEY
  )
    return new Response(null, { status: 204 });
  const workflow = /^\/api\/publications\/([^/]+)(?:\/media\/([^/]+))?$/.exec(
    pathname,
  );
  if (
    workflow &&
    publicationIdPattern.test(workflow[1]) &&
    ["GET", "PUT"].includes(request.method)
  )
    return workflowPublication(request, env, workflow[1], workflow[2]);
  const media = /^\/api\/content\/media\/([^/]+)$/.exec(pathname);
  if (media && request.method === "GET")
    return draftMedia(request, env, media[1]);

  switch (`${request.method} ${pathname}`) {
    case "POST /api/auth/request-code":
      return requestCode(request, env);
    case "POST /api/auth/verify-code":
      return verifyCode(request, env);
    case "POST /api/auth/revoke/request":
      return requestCode(request, env, true);
    case "POST /api/auth/revoke/confirm":
      return verifyCode(request, env, true);
    case "GET /api/session":
      return json({ site: await getSession(request, env) });
    case "POST /api/auth/logout": {
      const tokenHash = await sessionTokenHash(request);
      if (tokenHash)
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
          .bind(tokenHash)
          .run();
      return new Response(null, { status: 204 });
    }
    case "GET /api/content":
      return siteContent(request, env, "content");
    case "PUT /api/content/draft":
      return siteContent(request, env, "draft");
    case "POST /api/content/media":
      return draftMedia(request, env);
    case "POST /api/content/publish":
      return siteContent(request, env, "publish");
    case "GET /api/content/publication":
      return siteContent(request, env, "status");
    default:
      return json({ error: "Запрос не поддерживается." }, 404);
  }
}

export default {
  async scheduled(_event: unknown, env: Env) {
    await cleanUnusedUploads(env);
  },
  async fetch(request: Request, env: Env) {
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const origin = request.headers.get("Origin");
    if (origin) {
      const allowed = env.ALLOWED_ORIGINS.split(",").map((value) =>
        value.trim(),
      );
      if (!allowed.includes(origin))
        return json({ error: "Этот адрес админки не подключён." }, 403);
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
    }
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });

    let response: Response;
    try {
      response = await handle(request, env);
    } catch (error) {
      response =
        error instanceof RequestError
          ? json({ error: error.message }, error.status)
          : json(
              { error: "Сервис временно недоступен. Попробуйте ещё раз." },
              500,
            );
    }
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  },
};

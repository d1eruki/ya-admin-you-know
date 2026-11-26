import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { startSecurityTestEnvironment } from "./dev-local.mjs";

const siteRoot = process.argv[2];
if (!siteRoot) throw new Error("Укажите путь к локальной копии Port Heaven.");
const siteRequire = createRequire(path.resolve(siteRoot, "package.json"));
const sharp = siteRequire("sharp");
const useBrowser = process.argv.includes("--browser");
const local = await startSecurityTestEnvironment(siteRoot, {
  browser: useBrowser,
});
let browser;

async function checkEncryptedArtifacts() {
  const root = await mkdtemp(path.join(tmpdir(), "ya-admin-artifacts-"));
  const script = path.resolve(siteRoot, "scripts/apply-admin-publication.mjs");
  const source = path.join(root, "input");
  const sealed = path.join(root, "sealed");
  const opened = path.join(root, "opened");
  const env = {
    PUBLICATION_ID: randomUUID(),
    PUBLISH_ARTIFACT_KEY: randomBytes(32).toString("hex"),
  };
  const run = (args, extra = {}) =>
    promisify(execFile)(process.execPath, [script, ...args], {
      env: { ...env, ...extra },
    });
  try {
    const plaintext = Buffer.from('{"draft":"private example"}');
    await mkdir(source);
    await writeFile(path.join(source, "content-manifest.json"), plaintext);
    await run(["seal", "input", source, sealed]);
    const encryptedPath = path.join(sealed, "content-manifest.json.enc");
    const ciphertext = await readFile(encryptedPath);
    assert.equal(ciphertext.includes(plaintext), false);
    await assert.rejects(
      run(["open", "input", sealed, opened], { PUBLICATION_ID: randomUUID() }),
    );
    await run(["open", "input", sealed, opened]);
    assert.deepEqual(
      await readFile(path.join(opened, "content-manifest.json")),
      plaintext,
    );
    ciphertext[ciphertext.length - 1] ^= 1;
    await writeFile(encryptedPath, ciphertext);
    await assert.rejects(
      run(["open", "input", sealed, path.join(root, "tampered")]),
    );

    await writeFile(path.join(source, "artifact.tar"), plaintext);
    await run(["seal", "site", source, sealed]);
    await run(["open", "site", sealed, opened]);
    assert.deepEqual(
      await readFile(path.join(opened, "artifact.tar")),
      plaintext,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  const [site, otherSite] = local.siteAddresses;
  const call = (pathname, { token, method = "GET", data, raw, type } = {}) =>
    fetch(local.api + pathname, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(data || raw ? { "Content-Type": type ?? "application/json" } : {}),
      },
      body: raw ?? (data && JSON.stringify(data)),
      signal: AbortSignal.timeout(12_000),
    });
  async function expect(response, status) {
    assert.equal(
      response.status,
      status,
      await response
        .clone()
        .text()
        .catch(() => ""),
    );
    if (response.headers.get("content-type")?.includes("application/json"))
      return response.json();
    return response;
  }
  const content = (token) =>
    call("/api/content", { token }).then((res) => expect(res, 200));
  const upload = (token, raw, type = "image/png") =>
    call("/api/content/media", { token, method: "POST", raw, type });
  const save = (token, revision, edits) =>
    call("/api/content/draft", {
      token,
      method: "PUT",
      data: { revision, edits },
    });
  const publish = (token, revision) =>
    call("/api/content/publish", { token, method: "POST", data: { revision } });
  async function waitForPublication(token, wanted) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await expect(
        await call("/api/content/publication", { token }),
        200,
      );
      if (status.publication?.status === wanted) return status.publication;
      if (local.getPublicationError()) throw local.getPublicationError();
      await setTimeout(80);
    }
    throw new Error(`Publication did not reach ${wanted}`);
  }

  const original = local.getManifest();
  assert.equal(original.schemaVersion, 1);
  assert.ok(original.fields.length > 1);
  const textField = original.fields.find(({ key }) => key === "ru.brand.hero");
  const imageField = original.fields.find(
    ({ key }) => key === "image.project.medved.cover",
  );
  assert.ok(textField && imageField);
  await expect(await call("/api/content"), 401);
  await expect(
    await call("/api/auth/revoke/request", { method: "POST", data: {} }),
    401,
  );
  const login = await expect(
    await call("/api/auth/request-code", {
      method: "POST",
      data: { address: site },
    }),
    202,
  );
  const loginCode = local.mailbox.at(-1)?.code;
  assert.match(loginCode ?? "", /^\d{6}$/);
  const response = await expect(
    await call("/api/auth/verify-code", {
      method: "POST",
      data: { address: site, challengeId: login.challengeId, code: loginCode },
    }),
    200,
  );
  const session = response.token;
  const oldSession = await local.seedSession(site);
  const other = await local.seedSession(otherSite);
  await expect(
    await call("/api/auth/verify-code", {
      method: "POST",
      data: { address: site, challengeId: login.challengeId, code: loginCode },
    }),
    401,
  );
  assert.equal((await content(other)).fields.length, original.fields.length);

  const image = sharp({
    create: { width: 240, height: 180, channels: 3, background: "#ef2970" },
  });
  const png = await image.clone().png().toBuffer();
  await expect(await upload(session, Buffer.from("not an image")), 400);
  await expect(await upload(session, png.subarray(0, -8)), 400);
  const malformed = Buffer.from(png);
  malformed.writeUInt32BE(4097, 16);
  await expect(await upload(session, malformed), 400);
  await expect(await upload(session, Buffer.alloc(4 * 1024 * 1024 + 1)), 413);

  const jpg = await image
    .clone()
    .withMetadata({ comment: "LOCAL-QA-METADATA" })
    .jpeg()
    .toBuffer();
  assert.ok((await sharp(jpg).metadata()).exif);
  const savedImage = await expect(
    await upload(session, jpg, "image/jpeg"),
    201,
  );
  const jpegPreview = "/api/content/media/" + savedImage.id;
  await expect(await call(jpegPreview), 401);
  await expect(await call(jpegPreview, { token: other }), 404);
  await expect(await call(jpegPreview, { token: session }), 200);
  const webp = await image.clone().webp().toBuffer();
  const unused = await expect(await upload(session, webp, "image/webp"), 201);

  const baseline = await content(session);
  await expect(
    await save(other, (await content(other)).revision, {
      [imageField.key]: savedImage.id,
    }),
    400,
  );
  const newlyPublishedText = "Локальная проверка безопасности";
  const draft = await expect(
    await save(session, baseline.revision, {
      [textField.key]: newlyPublishedText,
      [imageField.key]: savedImage.id,
    }),
    200,
  );
  assert.deepEqual((await content(other)).draft, {});
  await local.sql(
    `UPDATE site_media_uploads SET created_at = 1 WHERE id IN ('${savedImage.id}', '${unused.id}');`,
  );
  await expect(await fetch(local.api + "/cdn-cgi/handler/scheduled"), 200);
  await expect(
    await call("/api/content/media/" + unused.id, { token: session }),
    404,
  );
  await expect(await call(jpegPreview, { token: session }), 200);

  const conflictManifest = structuredClone(original);
  conflictManifest.fields.find(({ key }) => key === textField.key).value =
    "Правка из репозитория";
  local.setManifest(conflictManifest);
  await expect(await publish(session, (await content(session)).revision), 202);
  const failure = await waitForPublication(session, "failed");
  assert.match(failure.message, /Поля на сайте изменились/);
  assert.deepEqual((await content(session)).draft, draft.draft);

  local.setManifest(original);
  await expect(await publish(session, (await content(session)).revision), 202);
  await waitForPublication(session, "succeeded");
  assert.deepEqual((await content(session)).draft, {});
  const otherContent = await content(other);
  assert.equal(
    otherContent.fields.find(({ key }) => key === textField.key).value,
    textField.value,
  );
  const published = local.getManifest();
  assert.equal(
    published.fields.find(({ key }) => key === textField.key).value,
    newlyPublishedText,
  );
  const imagePath = published.fields.find(
    ({ key }) => key === imageField.key,
  ).value;
  const sanitized = local.getPublishedImage(imagePath);
  assert.ok(sanitized);
  assert.equal((await sharp(sanitized).metadata()).exif, undefined);
  assert.equal((await sharp(sanitized).metadata()).width, 240);

  for (let count = 0; count < 20; count++)
    await expect(await upload(session, png), 201);
  await expect(await upload(session, png), 429);
  await expect(await upload(other, png), 201);

  let revoke;
  let page;
  if (useBrowser) {
    const { chromium } = siteRequire("playwright");
    browser = await chromium.launch({ channel: "chrome" });
    page = await browser.newPage();
    await page.addInitScript(
      (token) => sessionStorage.setItem("ya-admin-you-know:session", token),
      session,
    );
    await page.goto(local.frontend);
    await page.getByRole("button", { name: "Завершить все сеансы" }).click();
    const dialog = page.getByRole("dialog");
    const [response] = await Promise.all([
      page.waitForResponse((result) =>
        result.url().endsWith("/api/auth/revoke/request"),
      ),
      dialog.getByRole("button", { name: "Получить код" }).click(),
    ]);
    assert.equal(response.status(), 202);
    revoke = await response.json();
  } else {
    revoke = await expect(
      await call("/api/auth/revoke/request", {
        token: session,
        method: "POST",
        data: { address: otherSite },
      }),
      202,
    );
  }
  const code = local.mailbox.at(-1)?.code;
  assert.match(code ?? "", /^\d{6}$/);
  assert.match(local.mailbox.at(-1).subject, /отзыва всех сессий/);
  assert.equal(local.mailbox.at(-1).to, "site-1@example.invalid");
  const confirmed = { challengeId: revoke.challengeId, code };
  const wrong = (Number(code) + 1) % 1_000_000;
  await expect(
    await call("/api/auth/revoke/confirm", {
      token: session,
      method: "POST",
      data: { ...confirmed, code: String(wrong).padStart(6, "0") },
    }),
    401,
  );
  await expect(
    await call("/api/auth/revoke/confirm", {
      token: other,
      method: "POST",
      data: confirmed,
    }),
    401,
  );
  if (page) {
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Код из письма").fill(code);
    const [response] = await Promise.all([
      page.waitForResponse((result) =>
        result.url().endsWith("/api/auth/revoke/confirm"),
      ),
      dialog.getByRole("button", { name: "Завершить сеансы" }).click(),
    ]);
    assert.equal(response.status(), 204);
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("ya-admin-you-know:session"),
      ),
      null,
    );
  } else {
    await expect(
      await call("/api/auth/revoke/confirm", {
        token: session,
        method: "POST",
        data: confirmed,
      }),
      204,
    );
  }
  await expect(await call("/api/content", { token: oldSession }), 401);
  await expect(await call("/api/content", { token: session }), 401);
  await expect(
    await call("/api/auth/revoke/confirm", {
      token: session,
      method: "POST",
      data: confirmed,
    }),
    401,
  );
  assert.equal((await content(other)).fields.length, original.fields.length);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.resolve(siteRoot, "content-manifest.json"), "utf8"),
    ),
    original,
  );
  await checkEncryptedArtifacts();
  console.log(
    "Локальные проверки прошли: вход, межсайтовая изоляция, отзыв сессий, загрузки и квота, очистка R2, конфликт и публикация без EXIF.",
  );
} finally {
  await browser?.close();
  await local.stop();
}

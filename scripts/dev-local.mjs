import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const frontend = "http://127.0.0.1:5174";
const api = "http://127.0.0.1:8788";
const bridge = "http://127.0.0.1:8790";
const repository = "local/port-heaven";
const refFor = (index) => "preview-" + (index + 1);
const siteAddresses = ["https://pilot.example/", "https://other.example/"];
const wrangler = path.join(
  projectRoot,
  "node_modules/wrangler/bin/wrangler.js",
);
const vite = path.join(projectRoot, "node_modules/vite/bin/vite.js");
const imageExtension = /\.(?:avif|png|jpe?g|webp)$/i;

function localEnv(directory) {
  return {
    PATH: process.env.PATH,
    HOME: directory,
    TMPDIR: directory,
    WRANGLER_LOG_PATH: path.join(directory, "wrangler.log"),
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
}

async function fileExists(file) {
  try {
    await realpath(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readLocalImage(root, relative) {
  if (
    !relative.startsWith("src/assets/") ||
    !imageExtension.test(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  const file = path.resolve(root, relative);
  if (!(await fileExists(file))) return null;
  const absolute = await realpath(file);
  if (!absolute.startsWith(root + path.sep)) return null;
  return readFile(absolute);
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const buffers = [];
  let length = 0;
  for await (const buffer of request) {
    length += buffer.length;
    if (length > 4096) throw new Error("Local request is too long");
    buffers.push(buffer);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}

export async function startSecurityTestEnvironment(
  portHeavenPath,
  { browser = false } = {},
) {
  if (!portHeavenPath)
    throw new Error(
      "Укажите путь к локальной копии Port Heaven с манифестом и npm-зависимостями.",
    );
  const siteRoot = await realpath(portHeavenPath);
  const manifestName = "content-manifest.json";
  const original = JSON.parse(
    await readFile(path.join(siteRoot, manifestName), "utf8"),
  );
  const applyScript = path.join(
    siteRoot,
    "scripts/apply-admin-publication.mjs",
  );
  if (!(await fileExists(applyScript)))
    throw new Error("Нужен checkout Port Heaven с настройкой публикации.");
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ya-admin-local-")),
  );
  const sites = new Map(
    siteAddresses.map((_, index) => [
      refFor(index),
      { manifest: structuredClone(original), publishedMedia: new Map() },
    ]),
  );
  const primary = sites.get(refFor(0));
  const mailbox = [];
  const children = [];
  const activeRuns = new Set();
  const mailKey = randomBytes(32).toString("hex");
  const dispatchKey = randomBytes(32).toString("hex");
  const workflowKey = randomBytes(32).toString("hex");
  const config = path.join(directory, "wrangler.json");
  const persistence = path.join(directory, "state");
  const env = localEnv(directory);
  let runCount = 0;
  let publicationError = null;

  async function finishPublication(id, ref, localSite) {
    const snapshot = structuredClone(localSite.manifest);
    const jobDir = await mkdtemp(path.join(directory, "publication-"));
    const stage = path.join(jobDir, "stage");
    const githubEnv = path.join(jobDir, "github-env");
    const jobEnv = {
      ...env,
      ADMIN_API_URL: api,
      PUBLISH_WORKFLOW_SECRET: workflowKey,
      PUBLICATION_ID: id,
      GITHUB_RUN_ID: String(++runCount),
      GITHUB_REF_NAME: ref,
      GITHUB_ENV: githubEnv,
      PUBLICATION_STAGE_DIR: stage,
    };
    const options = { cwd: jobDir, env: jobEnv };
    let outcome = "succeeded";
    await writeFile(path.join(jobDir, manifestName), JSON.stringify(snapshot));
    await writeFile(githubEnv, "");
    try {
      await run(process.execPath, [applyScript, "apply"], options);
      const assets = path.join(stage, "assets");
      if (await fileExists(assets)) {
        await run(process.execPath, [applyScript, "sanitize", assets], {
          cwd: jobDir,
          env,
        });
        for (const file of await readdir(assets)) {
          localSite.publishedMedia.set(
            "src/assets/admin-content/" + file,
            await readFile(path.join(assets, file)),
          );
        }
      }
      localSite.manifest = JSON.parse(
        await readFile(path.join(stage, manifestName), "utf8"),
      );
    } catch (error) {
      outcome = "failed";
      if (
        (await readFile(githubEnv, "utf8")).includes(
          "ADMIN_PUBLICATION_FAILURE=conflict",
        )
      ) {
        jobEnv.ADMIN_PUBLICATION_FAILURE = "conflict";
      } else {
        publicationError = error;
      }
    }
    await run(process.execPath, [applyScript, outcome], options);
    await rm(jobDir, { recursive: true, force: true });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, bridge);
      if (url.origin !== bridge) return json(response, 400, {});
      const resource = /^\/content\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (request.method === "GET" && resource) {
        const localSite = sites.get(resource[1]);
        if (!localSite) return json(response, 404, {});
        const relative = decodeURIComponent(resource[2]);
        if (relative === manifestName)
          return json(response, 200, localSite.manifest);
        const image =
          localSite.publishedMedia.get(relative) ??
          (await readLocalImage(siteRoot, relative));
        if (!image) return json(response, 404, {});
        const type = path
          .extname(relative)
          .slice(1)
          .toLowerCase()
          .replace(/^(jpg|jpeg)$/, "jpeg");
        response.writeHead(200, {
          "Content-Type": "image/" + type,
          "X-Content-Type-Options": "nosniff",
        });
        return response.end(image);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/mail" &&
        request.headers.authorization === "Bearer " + mailKey
      ) {
        const mail = await readJson(request);
        const code = /: (\d{6})\n/.exec(mail.text)?.[1];
        mailbox.push({ to: mail.to?.[0], subject: mail.subject, code });
        return json(response, 202, { id: randomUUID() });
      }
      if (
        request.method === "POST" &&
        url.pathname === "/dispatch" &&
        request.headers.authorization === "Bearer " + dispatchKey
      ) {
        const data = await readJson(request);
        const id = data.inputs?.publication;
        const localSite = sites.get(data.ref);
        if (!localSite || !/^[a-f0-9-]{36}$/.test(id ?? ""))
          return json(response, 400, {});
        response.writeHead(204).end();
        const job = finishPublication(id, data.ref, localSite).catch(
          (error) => {
            publicationError = error;
          },
        );
        activeRuns.add(job);
        void job.finally(() => activeRuns.delete(job));
        return;
      }
      return json(response, 404, {});
    } catch {
      return json(response, 400, {});
    }
  });

  async function sql(statement) {
    const result = await run(
      process.execPath,
      [
        wrangler,
        "d1",
        "execute",
        "DB",
        "--config",
        config,
        "--local",
        "--persist-to",
        persistence,
        "--command",
        statement,
      ],
      { cwd: directory, env },
    );
    return result.stdout;
  }

  function start(script, args, extraEnv = {}) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: script === vite ? projectRoot : directory,
      env: { ...env, ...extraEnv },
      stdio: "ignore",
    });
    children.push(child);
    return child;
  }

  async function stop() {
    await Promise.all([...activeRuns]);
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null)
              return resolve();
            child.once("exit", resolve);
            child.kill("SIGTERM");
          }),
      ),
    );
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }

  try {
    const migrations = path.join(directory, "migrations");
    await mkdir(migrations);
    for (const entry of await readdir(
      path.join(projectRoot, "worker/migrations"),
    )) {
      if (/^\w+\.sql$/.test(entry)) {
        await copyFile(
          path.join(projectRoot, "worker/migrations", entry),
          path.join(migrations, entry),
        );
      }
    }
    const worker = path.join(directory, "index.ts");
    const data = await readFile(
      path.join(projectRoot, "worker/index.ts"),
      "utf8",
    );
    await writeFile(worker, data.replace(/^import type .*;\n/m, ""));
    const localSecrets = {
      AUTH_SECRET: randomBytes(32).toString("hex"),
      RESEND_API_KEY: mailKey,
      GITHUB_PUBLISH_TOKEN: dispatchKey,
      PUBLISH_WORKFLOW_SECRET: workflowKey,
    };
    await writeFile(
      path.join(directory, ".dev.vars"),
      Object.entries(localSecrets)
        .map(([name, value]) => name + "=" + value)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    await writeFile(
      config,
      JSON.stringify({
        name: "ya-admin-local",
        main: "index.ts",
        compatibility_date: "2026-11-26",
        dev: { ip: "127.0.0.1", port: 8788 },
        d1_databases: [
          {
            binding: "DB",
            database_name: "ya-admin-local",
            database_id: randomUUID(),
            migrations_dir: "migrations",
          },
        ],
        r2_buckets: [
          { binding: "DRAFT_MEDIA", bucket_name: "ya-admin-local-drafts" },
        ],
        vars: {
          LOCAL_TEST_BRIDGE: bridge,
          ALLOWED_ORIGINS: frontend,
          MAIL_FROM: "test@example.invalid",
          PUBLISH_REPOSITORY: repository,
        },
      }),
      { mode: 0o600 },
    );

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(8790, "127.0.0.1", resolve);
    });
    await run(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--config",
        config,
        "--local",
        "--persist-to",
        persistence,
      ],
      { cwd: directory, env },
    );

    await sql(
      siteAddresses
        .map(
          (address, i) => `
      INSERT INTO sites (address, name, email) VALUES ('${address}', 'Локальный сайт ${i + 1}', 'site-${i + 1}@example.invalid');
      INSERT INTO site_content_sources (site_address, repository, source_ref, publish_ref) VALUES ('${address}', '${repository}', '${refFor(i)}', '${refFor(i)}');
    `,
        )
        .join("\n"),
    );

    const workerProcess = start(wrangler, [
      "dev",
      "--config",
      config,
      "--local",
      "--persist-to",
      persistence,
      "--test-scheduled",
    ]);
    let online = false;
    for (let i = 0; i < 60 && workerProcess.exitCode === null; i++) {
      const response = await fetch(api + "/api/local/ready", {
        headers: { Authorization: "Bearer " + mailKey },
        signal: AbortSignal.timeout(500),
      }).catch(() => null);
      if (response?.ok) {
        online = true;
        break;
      }
      await setTimeout(150);
    }
    if (!online) throw new Error("Локальный Worker не запустился.");
    if (browser) {
      const frontendProcess = start(
        vite,
        ["--bypass-lock", "--port", "5174", "--mode", "isolated-local"],
        { VITE_API_URL: api },
      );
      let ready = false;
      for (let i = 0; i < 50 && frontendProcess.exitCode === null; i++) {
        const response = await fetch(frontend, {
          signal: AbortSignal.timeout(500),
        }).catch(() => null);
        if (response?.ok) {
          ready = true;
          break;
        }
        await setTimeout(150);
      }
      if (!ready || frontendProcess.exitCode !== null)
        throw new Error("Локальный интерфейс не запустился.");
    }

    return {
      api,
      frontend,
      mailbox,
      siteAddresses,
      sql,
      stop,
      getPublicationError: () => publicationError,
      setManifest: (next) => {
        primary.manifest = structuredClone(next);
      },
      getManifest: () => structuredClone(primary.manifest),
      getPublishedImage: (relative) => primary.publishedMedia.get(relative),
      seedSession: async (address) => {
        if (!siteAddresses.includes(address))
          throw new Error("Unknown local site");
        const token = randomBytes(32).toString("hex");
        const hash = createHash("sha256").update(token).digest("hex");
        await sql(
          `INSERT INTO sessions VALUES ('${hash}', '${address}', ${Date.now() + 60 * 60_000});`,
        );
        return token;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

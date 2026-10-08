import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "deploy/prepare-node-image.sh");
const nodeDockerfiles = [
  "apps/knowledge/Dockerfile",
  "apps/web/Dockerfile",
  "apps/workbench-api/Dockerfile",
  "apps/workbench-export-worker/Dockerfile",
  "apps/workbench-file-worker/Dockerfile",
  "apps/workbench-import-worker/Dockerfile",
  "apps/workbench-preview/Dockerfile",
  "apps/workbench-worker/Dockerfile",
];

test("the Node image helper maps the approved Alpine package set and pins npm", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-node-image-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const log = path.join(fixture, "calls.log");
  for (const command of ["apk", "npm"]) {
    const executable = path.join(fixture, command);
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$WORKBENCH_TEST_LOG"\n`);
    await chmod(executable, 0o755);
  }

  const result = spawnSync("sh", [helper, "ca-certificates", "chromium", "coreutils", "fonts-dejavu-core", "openssl"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture}:${process.env.PATH}`,
      WORKBENCH_CONTAINER_NPM_VERSION: "11.18.0",
      WORKBENCH_TEST_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(log, "utf8"),
    [
      "apk add --no-cache ca-certificates chromium coreutils font-dejavu openssl",
      "npm install --global --ignore-scripts --no-audit --no-fund npm@11.18.0",
      "npm cache clean --force",
      "",
    ].join("\n"),
  );
});

for (const distribution of ["alpine", "debian"]) {
  test(`the Node image helper installs the document renderer dependencies on ${distribution}`, async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-document-image-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const log = path.join(fixture, "calls.log");
    const packageManager = distribution === "alpine" ? "apk" : "apt-get";
    for (const command of [packageManager, "npm", "sed", "rm"]) {
      const executable = path.join(fixture, command);
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> "$WORKBENCH_TEST_LOG"\n`);
      await chmod(executable, 0o755);
    }
    const packages = [
      "python3",
      "python3-lxml",
      "python3-pillow",
      "python3-virtualenv",
      "libreoffice-writer",
      "fonts-noto-cjk",
    ];
    const result = spawnSync("/bin/sh", [helper, ...packages], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fixture,
        WORKBENCH_CONTAINER_NPM_VERSION: "11.18.0",
        WORKBENCH_TEST_LOG: log,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const packageCalls = (await readFile(log, "utf8")).split("\n")
      .filter((line) => line.startsWith(`${packageManager} `));
    assert.deepEqual(packageCalls, distribution === "alpine"
      ? ["apk add --no-cache python3 py3-lxml py3-pillow py3-virtualenv libreoffice-writer font-noto-cjk"]
      : ["apt-get update", "apt-get install -y --no-install-recommends python3 python3-lxml python3-pil python3-virtualenv libreoffice-writer fonts-noto-cjk"]);
  });
}

test("the image helper still rejects unapproved Alpine packages before installing anything", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-rejected-image-package-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const executable = path.join(fixture, "apk");
  await writeFile(executable, "#!/bin/sh\nexit 99\n");
  await chmod(executable, 0o755);
  const result = spawnSync("/bin/sh", [helper, "unapproved-package"], {
    encoding: "utf8",
    env: { ...process.env, PATH: fixture },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported Alpine container package: unapproved-package/u);
});

test("the Export image includes the template and checker and verifies both document formats as its runtime user", async () => {
  const source = await readFile(path.join(root, "apps/workbench-export-worker/Dockerfile"), "utf8");
  for (const file of [
    "integrations/deerflow/skills/requirement-doc-template/assets/requirement-template.docx",
    "integrations/deerflow/skills/requirement-doc-template/scripts/docx_quality_check.py",
    "deploy/check-workbench-document-export.mjs",
  ]) {
    assert.ok(source.includes(`COPY --chown=node:node ${file} ${file}`), `${file} must be present in the runtime image`);
  }
  assert.match(source, /--system-site-packages \/opt\/workbench-export-python/u);
  assert.match(source, /--only-binary=:all: --no-deps --require-hashes/u);
  assert.match(source, /USER node\nRUN node deploy\/check-workbench-document-export\.mjs/u);
});

test("all candidate Node Dockerfiles use the hardened Alpine helper", async () => {
  for (const relativePath of nodeDockerfiles) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.match(source, /^ARG NODE_IMAGE=node:22-alpine$/mu, `${relativePath} must default to Node 22 Alpine`);
    assert.match(source, /deploy\/prepare-node-image\.sh/u, `${relativePath} must copy the image hardening helper`);
    assert.match(source, /prepare-node-image/u, `${relativePath} must execute the image hardening helper`);
    assert.doesNotMatch(source, /node:22-bookworm-slim/u, `${relativePath} retains the vulnerable Debian base`);
  }

  const workflow = await readFile(path.join(root, ".github/workflows/workbench-ci.yml"), "utf8");
  assert.doesNotMatch(workflow, /node:22-bookworm-slim/u, "CI retains the vulnerable Debian Node fallback");
  assert.doesNotMatch(workflow, /nginx:1\.27\.5-alpine/u, "CI retains the vulnerable Nginx fallback");
  assert.match(workflow, /NODE_IMAGE=.*node:22-alpine/u);
  assert.match(workflow, /NGINX_IMAGE: .*nginx:stable-alpine/u);
});

test("the Web image gives production type checking enough heap", async () => {
  const source = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
  assert.match(source, /NODE_OPTIONS=--max-old-space-size=4096/u);
});

test("the Web and CI builds pin their Linux x64 native dependencies", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const nativePins = {
    "@esbuild/linux-x64": "0.28.1",
    "@next/swc-linux-x64-musl": "16.2.12",
    "@rolldown/binding-linux-x64-gnu": "1.1.4",
    "@rolldown/binding-linux-x64-musl": "1.1.4",
    "@tailwindcss/oxide-linux-x64-gnu": "4.3.1",
    "@tailwindcss/oxide-linux-x64-musl": "4.3.1",
    "lightningcss-linux-x64-gnu": "1.32.0",
    "lightningcss-linux-x64-musl": "1.32.0",
  };

  for (const [name, version] of Object.entries(nativePins)) {
    assert.equal(manifest.optionalDependencies?.[name], version, `${name} must be pinned in package.json`);
    assert.equal(lockfile.packages?.[""]?.optionalDependencies?.[name], version, `${name} must be pinned in package-lock.json`);
    const lockedPackage = lockfile.packages?.[`node_modules/${name}`];
    assert.equal(lockedPackage?.version, version, `${name} must have a complete lockfile entry`);
    assert.equal(lockedPackage?.optional, true, `${name} must remain optional outside Linux x64 builds`);
    assert.match(lockedPackage?.integrity ?? "", /^sha512-/u, `${name} must retain registry integrity metadata`);
  }

  const webDockerfile = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
  assert.match(webDockerfile, /npm ci --include=dev --include=optional/u);
  assert.match(webDockerfile, /require\('lightningcss'\); require\('@tailwindcss\/oxide'\)/u);
  assert.match(webDockerfile, /WORKDIR \/app\/apps\/web\nUSER node\nEXPOSE 3000/u);

  assert.deepEqual(manifest.allowScripts, {
    "@prisma/client": false,
    "@prisma/engines": false,
    esbuild: false,
    prisma: false,
    sharp: false,
  });
});

test("the API image preserves and probes the musl Sharp runtime", async () => {
  const source = await readFile(path.join(root, "apps/workbench-api/Dockerfile"), "utf8");
  assert.match(
    source,
    /COPY --from=production-dependencies --chown=node:node \/app\/apps\/workbench-api\/node_modules\/@img\/ node_modules\/@img\//u,
  );
  assert.match(source, /cp -a node_modules\/@img apps\/workbench-api\/node_modules\/@img/u);
  assert.match(source, /const sharp = require\('sharp'\); if \(!sharp\.versions\.vips\) process\.exit\(1\)/u);
});

test("candidate security dependency fixes remain exactly pinned", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.overrides?.["fast-xml-parser"], "5.10.1");
  assert.equal(manifest.overrides?.["js-yaml"], "4.3.0");

  const figmaManifest = JSON.parse(
    await readFile(path.join(root, "apps/workbench-figma-importer/package.json"), "utf8"),
  );
  assert.equal(figmaManifest.dependencies?.preact, "10.29.7");

  for (const relativePath of [
    "apps/workbench-api/package.json",
    "apps/workbench-worker/package.json",
    "apps/workbench-file-worker/package.json",
    "apps/workbench-import-worker/package.json",
    "apps/workbench-export-worker/package.json",
    "apps/workbench-preview/package.json",
  ]) {
    const serviceManifest = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
    assert.equal(serviceManifest.dependencies?.["@aws-sdk/client-s3"], "3.896.0", `${relativePath} S3 client drifted`);
  }

  const apiManifest = JSON.parse(
    await readFile(path.join(root, "apps/workbench-api/package.json"), "utf8"),
  );
  assert.equal(apiManifest.dependencies?.["@aws-sdk/s3-request-presigner"], "3.896.0");
});

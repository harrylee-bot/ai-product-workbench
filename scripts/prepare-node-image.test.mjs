import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { collectWorkspaceRuntimeDependencies } from "../deploy/collect-workspace-runtime-dependencies.mjs";

const root = path.resolve(import.meta.dirname, "..");
const helper = path.join(root, "deploy/prepare-node-image.sh");
const timeoutExecutable = spawnSync("/bin/sh", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();
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
      "apk add --no-cache --timeout 30 ca-certificates chromium coreutils font-dejavu openssl",
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
    if (distribution === "alpine") await symlink(timeoutExecutable, path.join(fixture, "timeout"));
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
      ? ["apk add --no-cache --timeout 30 python3 py3-lxml py3-pillow py3-virtualenv libreoffice-writer font-noto-cjk"]
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

for (const recover of [true, false]) {
  test(`a stalled Alpine package request ${recover ? "recovers on the next attempt" : "stops after three attempts without running npm"}`, async (t) => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-apk-timeout-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const log = path.join(fixture, "calls.log");
    await symlink(timeoutExecutable, path.join(fixture, "timeout"));
    const commands = {
      apk: `attempt=0\nif [ -f "$WORKBENCH_TEST_LOG.count" ]; then read -r attempt < "$WORKBENCH_TEST_LOG.count"; fi\nattempt=$((attempt + 1))\nprintf '%s\\n' "$attempt" > "$WORKBENCH_TEST_LOG.count"\nprintf 'apk %s\\n' "$attempt" >> "$WORKBENCH_TEST_LOG"\n${recover ? '[ "$attempt" -gt 1 ] && exit 0' : ':'}\nexec /bin/sleep 30`,
      npm: 'printf "npm\\n" >> "$WORKBENCH_TEST_LOG"',
      sleep: ':',
      sed: ':',
    };
    for (const [command, body] of Object.entries(commands)) {
      const executable = path.join(fixture, command);
      await writeFile(executable, `#!/bin/sh\n${body}\n`);
      await chmod(executable, 0o755);
    }
    const result = spawnSync("/bin/sh", [helper, "openssl"], {
      encoding: "utf8", timeout: 12_000,
      env: { ...process.env, PATH: fixture, WORKBENCH_APK_TIMEOUT_SECONDS: "1", WORKBENCH_TEST_LOG: log },
    });
    assert.equal(result.error, undefined, "the helper must return before the outer test deadline");
    assert.equal(result.status, recover ? 0 : 1, result.stderr);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"),
      recover ? ["apk 1", "apk 2", "npm", "npm"] : ["apk 1", "apk 2", "apk 3"]);
    if (!recover) assert.match(result.stderr, /after bounded mirror retries/u);
  });
}

test("Alpine installation fails closed when the deadline utility is missing", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-missing-timeout-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, "apk"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const result = spawnSync("/bin/sh", [helper, "openssl"], { encoding: "utf8", env: { ...process.env, PATH: fixture } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timeout is required/u);
});

test("the Export image includes the template and checker for deployment-time AMD64 verification", async () => {
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
  assert.match(source, /USER node\nHEALTHCHECK /u);
  assert.doesNotMatch(
    source,
    /USER node\nRUN node deploy\/check-workbench-document-export\.mjs/u,
    "document rendering must be verified by the deployment preflight on a real linux\/amd64 image",
  );
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
  assert.match(workflow, /NODE_IMAGE=\$\{\{ vars\.WORKBENCH_NODE_IMAGE \}\}/u);
  assert.match(workflow, /NGINX_IMAGE: .*nginx:stable-alpine/u);
});

test("the Web image keeps the isolated compiler heap below the three-GiB builder limit", async () => {
  const source = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
  assert.match(source, /NODE_OPTIONS=--max-old-space-size=2048/u);
});

test("Web production type checking excludes test-only workspaces while full type checking retains every test", async () => {
  const requireWeb = createRequire(path.join(root, "apps/web/package.json"));
  const ts = requireWeb("typescript");
  const web = path.join(root, "apps/web");
  const readConfig = (filename) => {
    const config = ts.readConfigFile(path.join(web, filename), ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, web);
    assert.deepEqual(parsed.errors, []);
    return parsed;
  };
  const full = readConfig("tsconfig.json");
  const production = readConfig("tsconfig.build.json");
  const isTest = (filename) => /(?:\.(?:spec|test)\.[^/]+$|\/(?:__tests__|__mocks__)\/|\/vitest\.[^/]+\.ts$)/u.test(filename);
  const bootstrapTest = path.join(web, "lib/auth/bootstrap-account.postgres.spec.ts");
  assert(full.fileNames.includes(bootstrapTest), "full type checking must retain the real database authentication regression");
  assert(!production.fileNames.includes(bootstrapTest), "the production compiler must not require the test-only database workspace");
  assert(full.fileNames.some(isTest), "the complete config must still include tests");
  assert(!production.fileNames.some(isTest), "production roots must exclude spec/test files and the Vitest runner config");
  assert.deepEqual(production.fileNames, full.fileNames.filter((filename) => !isTest(filename)),
    "the production boundary must retain every non-test source and generated route declaration");
  for (const option of ["strict", "noEmit", "moduleResolution", "jsx", "paths"]) {
    assert.deepEqual(production.options[option], full.options[option], `production must preserve ${option}`);
  }
  const program = ts.createProgram(production.fileNames, production.options);
  assert(!program.getSourceFiles().some((source) => source.fileName.includes("/workbench-db/")),
    "production imports must not pull the database workspace back into the program");
  const manifest = JSON.parse(await readFile(path.join(web, "package.json"), "utf8"));
  assert.match(manifest.scripts.typecheck, /tsc -p tsconfig\.json --noEmit/u);
  assert.equal(manifest.dependencies["@workbench/workbench-db"], undefined);
  const dockerfile = await readFile(path.join(web, "Dockerfile"), "utf8");
  assert.match(dockerfile, /next typegen && npx tsc -p tsconfig\.build\.json --noEmit/u);
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/web\/tsconfig\.json \/app\/apps\/web\/tsconfig\.build\.json apps\/web\//u);
  assert.doesNotMatch(dockerfile, /COPY packages\/workbench-db/u);
  const nextConfig = await readFile(path.join(web, "next.config.ts"), "utf8");
  assert.match(nextConfig, /tsconfigPath: configuredTsconfigPath \?\? "tsconfig\.build\.json"/u);
});

test("the Web and CI builds pin native dependencies for production x64 and the ARM64 runner", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const nativePins = {
    "@esbuild/linux-x64": "0.28.1",
    "@next/swc-linux-x64-musl": "16.3.8",
    "@rolldown/binding-linux-x64-gnu": "1.1.4",
    "@rolldown/binding-linux-x64-musl": "1.1.4",
    "@tailwindcss/oxide-linux-arm64-gnu": "4.3.1",
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
    assert.equal(lockedPackage?.optional, true, `${name} must remain optional outside its target platform`);
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

test("the API image keeps native dependency locations and runs a real Sharp image transform", async () => {
  const source = await readFile(path.join(root, "apps/workbench-api/Dockerfile"), "utf8");
  assert.doesNotMatch(source, /cp -a node_modules\/@img/u);
  assert.doesNotMatch(source, /COPY[^\n]+node_modules\/@img/u);
  assert.match(source, /RUN cd \/app\/apps\/workbench-api/u);
  const probe = source.match(/node --input-type=module -e "([^"]+SHARP_RUNTIME_SMOKE_FAILED[^"]+)"/u)?.[1];
  assert.ok(probe, "the final runner must decode, resize and verify actual image pixels");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: path.join(root, "apps/workbench-api"), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the API native Sharp pins match its release's libvips ABI on glibc and musl", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "apps/workbench-api/package.json"), "utf8"));
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const locked = (name) => lockfile.packages[`apps/workbench-api/node_modules/${name}`]
    ?? lockfile.packages[`node_modules/${name}`];
  const sharp = locked("sharp");
  assert.equal(sharp.version, manifest.dependencies.sharp);
  for (const platform of ["linux-x64", "linuxmusl-x64"]) {
    const binding = `@img/sharp-${platform}`;
    const libvips = `@img/sharp-libvips-${platform}`;
    for (const name of [binding, libvips]) {
      const required = sharp.optionalDependencies[name];
      assert.equal(manifest.optionalDependencies[name], required, `${name}: direct pin must match Sharp's ABI release`);
      assert.equal(lockfile.packages["apps/workbench-api"].optionalDependencies[name], required);
      assert.equal(locked(name).version, required, `${name}: the installed sibling must use the matching ABI`);
    }
    assert.equal(locked(binding).optionalDependencies[libvips], locked(libvips).version);
  }
});

test("candidate security dependency fixes remain exactly pinned", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.overrides?.["fast-xml-parser"], "5.10.1");
  assert.equal(manifest.overrides?.["js-yaml"], "4.3.2");

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

test("every workspace runner preserves production dependency directories with target-platform modules", async () => {
  const lockfile = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  for (const relativePath of nodeDockerfiles.filter((name) => name !== "apps/knowledge/Dockerfile")) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    const stage = relativePath === "apps/web/Dockerfile" ? "prod-deps" : "production-dependencies";
    const marker = relativePath === "apps/web/Dockerfile"
      ? "FROM --platform=$TARGETPLATFORM ${NODE_IMAGE} AS prod-deps\n"
      : `FROM build AS ${stage}\n`;
    const production = source.split(marker)[1]?.split(/^FROM /mu)[0];
    assert.ok(production, `${relativePath} must have a production dependency stage`);
    assert.match(production, /COPY deploy\/collect-workspace-runtime-dependencies\.mjs /u);
    const prune = production.indexOf(relativePath === "apps/web/Dockerfile"
      ? "npm ci --omit=dev --include=optional --ignore-scripts"
      : "npm prune --omit=dev");
    const collect = production.indexOf("node /usr/local/lib/collect-workspace-runtime-dependencies.mjs /app /app/.runtime-workspace-dependencies");
    assert.ok(prune >= 0 && collect > prune, `${relativePath} must collect only pruned production dependencies`);
    const runner = source.split(/^FROM .* AS runner\n/mu)[1];
    assert.ok(runner, `${relativePath} must have a runner stage`);
    assert.match(runner, new RegExp(`COPY --from=${stage}(?: --chown=node:node)? /app/node_modules node_modules`, "u"));
    assert.match(runner, new RegExp(`COPY --from=${stage}(?: --chown=node:node)? /app/\\.runtime-workspace-dependencies/ \\./`, "u"));
    const workspaces = new Set([...source.matchAll(/^COPY (?:--chown=\S+ )?((?:apps|packages)\/[^/]+)\/package\.json /gmu)].map((match) => match[1]));
    const nestedProduction = Object.entries(lockfile.packages)
      .filter(([name, metadata]) => !metadata.dev && workspaces.has(name.split("/node_modules/")[0]) && name.includes("/node_modules/"));
    assert.ok(nestedProduction.length > 0, `${relativePath} fixture must exercise the current nested dependency layout`);
  }
  const web = await readFile(path.join(root, "apps/web/Dockerfile"), "utf8");
  assert.match(web, /FROM --platform=\$BUILDPLATFORM \$\{NODE_IMAGE\} AS deps/u);
  assert.match(web, /FROM --platform=\$TARGETPLATFORM \$\{NODE_IMAGE\} AS prod-deps/u);
  assert.match(web, /npm ci --omit=dev --include=optional --ignore-scripts/u);
  assert.match(web, /require\.resolve\('next\/dist\/bin\/next'\)/u);
  assert.match(web, /require\('next\/package\.json'\)\.version !== require\('\.\/package\.json'\)\.dependencies\.next/u);
});

test("runtime dependency collection keeps nested module resolution and executable symlinks intact", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-dependencies-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const build = path.join(fixture, "build");
  const collected = path.join(fixture, "collected");
  const runner = path.join(fixture, "runner");
  const put = async (relativePath, content) => {
    const filename = path.join(build, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  };
  for (const workspace of ["apps/web", "packages/workbench-contracts", "packages/workbench-export-core", "packages/hoisted-only"]) {
    await put(`${workspace}/package.json`, "{}");
    await put(`${workspace}/source.js`, "throw new Error('must not be copied');");
  }
  await put("node_modules/zod/index.js", "exports.version = '4.0.0';");
  await put("packages/workbench-contracts/node_modules/zod/index.js", "exports.version = '3.0.0';");
  await put("packages/workbench-export-core/node_modules/@modelcontextprotocol/sdk/index.js", "exports.version = '1.32.1';");
  await put("apps/web/node_modules/next/dist/bin/next", "console.log('Next.js 16.3.8');");
  await mkdir(path.join(build, "apps/web/node_modules/.bin"));
  await symlink("../next/dist/bin/next", path.join(build, "apps/web/node_modules/.bin/next"));
  await put("apps/not-in-image/node_modules/unselected/index.js", "throw new Error('not a selected workspace');");

  assert.deepEqual(collectWorkspaceRuntimeDependencies(build, collected), [
    "apps/web", "packages/workbench-contracts", "packages/workbench-export-core",
  ]);
  await cp(collected, runner, { recursive: true, verbatimSymlinks: true });
  await cp(path.join(build, "node_modules"), path.join(runner, "node_modules"), { recursive: true });
  assert.equal(await readlink(path.join(runner, "apps/web/node_modules/.bin/next")), "../next/dist/bin/next");
  const cli = spawnSync(process.execPath, [path.join(runner, "apps/web/node_modules/.bin/next"), "--version"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), "Next.js 16.3.8");
  const requireRoot = createRequire(path.join(runner, "package.json"));
  const requireContracts = createRequire(path.join(runner, "packages/workbench-contracts/package.json"));
  const requireExport = createRequire(path.join(runner, "packages/workbench-export-core/package.json"));
  assert.equal(requireRoot("zod").version, "4.0.0");
  assert.equal(requireContracts("zod").version, "3.0.0");
  assert.equal(requireExport("@modelcontextprotocol/sdk").version, "1.32.1");
  for (const omitted of ["apps/web/source.js", "apps/not-in-image/node_modules/unselected/index.js", "packages/hoisted-only/node_modules"]) {
    await assert.rejects(readFile(path.join(runner, omitted)), { code: "ENOENT" });
  }
});

test("a fully hoisted install still produces a valid empty Docker COPY source", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "workbench-hoisted-dependencies-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const destination = path.join(fixture, "collected");
  assert.deepEqual(collectWorkspaceRuntimeDependencies(path.join(fixture, "empty"), destination), []);
  await cp(destination, path.join(fixture, "runner"), { recursive: true });
});

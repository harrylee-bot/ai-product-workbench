import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertSealedProductionRelease } from "./assert-sealed-production-release.mjs";

const script = fileURLToPath(new URL("./assert-sealed-production-release.mjs", import.meta.url));
const ownerUid = process.getuid?.() ?? 0;

test("accepts a sealed release and sealed external deployment inputs", () => {
  withFixture((fixture) => {
    const result = runCli(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "PASS");
  });
});

test("rejects a group-writable file anywhere in the release tree", () => {
  withFixture((fixture) => {
    chmodSync(path.join(fixture.releaseRoot, "deploy", "workbench-compose.yml"), 0o664);
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not be writable by group or other users/u);
  });
});

test("rejects release symlinks that resolve outside the sealed tree", () => {
  withFixture((fixture) => {
    symlinkSync(fixture.providerEnv, path.join(fixture.releaseRoot, "scripts", "escaped-provider.env"));
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must resolve inside the sealed release/u);
  });
});

test("rejects external hard links and symlink path replacement", () => {
  withFixture((fixture) => {
    linkSync(fixture.inventory, `${fixture.inventory}.alias`);
    let result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not have external hard links/u);

    rmSync(`${fixture.inventory}.alias`);
    rmSync(fixture.providerEnv);
    symlinkSync(fixture.inventory, fixture.providerEnv);
    result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /path components must not be symlinks/u);
  });
});

test("rejects an insecure external-input parent directory", () => {
  withFixture((fixture) => {
    chmodSync(path.dirname(fixture.providerEnv), 0o777);
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ancestor must not be writable by group or other users/u);
  });
});

test("rejects a release owned by a different fixed UID", () => {
  withFixture((fixture) => {
    assert.throws(() => assertSealedProductionRelease({
      releaseRoot: fixture.releaseRoot,
      environmentFile: fixture.environmentFile,
      ownerUid: ownerUid === 0 ? 1 : 0,
    }), /must be owned by UID/u);
  });
});

test("rejects ancestor symlinks in a configured release pathname", () => {
  withFixture((fixture) => {
    const alias = path.join(fixture.root, "release-parent-alias");
    symlinkSync(fixture.root, alias);
    const result = runCli(fixture, {
      releaseRoot: path.join(alias, path.basename(fixture.releaseRoot)),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /path components must not be symlinks/u);
  });
});

test("rejects a non-normalized release pathname", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, {
      releaseRoot: `${fixture.releaseRoot}/../${path.basename(fixture.releaseRoot)}`,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must use a normalized absolute path/u);
  });
});

test("rejects invalid UTF-8 in the release environment", () => {
  withFixture((fixture) => {
    writeFileSync(
      fixture.environmentFile,
      Buffer.concat([readFileSync(fixture.environmentFile), Buffer.from([0xff])]),
    );
    const result = runCli(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must contain valid UTF-8/u);
  });
});

test("rejects a repeated explicit owner UID even when both values are zero", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, {
      extraArguments: ["--owner-uid", "0"],
      owner: 0,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /usage: assert-sealed-production-release/u);
  });
});

function withFixture(run) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "workbench-sealed-release-"));
  const releaseRoot = path.join(root, "release");
  const configRoot = path.join(root, "config");
  const evidenceRoot = path.join(root, "evidence");
  const modelRoot = path.join(root, "models", "tokenizer");
  const deployRoot = path.join(releaseRoot, "deploy");
  const scriptRoot = path.join(releaseRoot, "scripts");
  mkdirSync(deployRoot, { recursive: true, mode: 0o755 });
  mkdirSync(scriptRoot, { recursive: true, mode: 0o755 });
  mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(modelRoot, { recursive: true, mode: 0o755 });
  writeFileSync(path.join(deployRoot, "server-deploy.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(path.join(deployRoot, "workbench-compose.yml"), "name: workbench\n", { mode: 0o644 });
  writeFileSync(path.join(scriptRoot, "tool.mjs"), "export {};\n", { mode: 0o644 });
  symlinkSync("tool.mjs", path.join(scriptRoot, "tool-link.mjs"));
  writeFileSync(path.join(modelRoot, "tokenizer.json"), "{}\n", { mode: 0o644 });

  const inventory = path.join(evidenceRoot, "production-image-manifest.json");
  const inventoryBundle = path.join(evidenceRoot, "production-image-manifest.bundle.json");
  const providerEnv = path.join(configRoot, "provider.env");
  const privateKey = path.join(configRoot, "runtime-worker.key");
  const environmentFile = path.join(configRoot, "workbench.env");
  writeFileSync(inventory, "{}\n", { mode: 0o600 });
  writeFileSync(inventoryBundle, "{}\n", { mode: 0o600 });
  writeFileSync(providerEnv, "OPENAI_API_KEY=test\n", { mode: 0o600 });
  writeFileSync(privateKey, "test-key\n", { mode: 0o400 });
  writeFileSync(environmentFile, [
    `WORKBENCH_IMAGE_INVENTORY_PATH=${inventory}`,
    `WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=${inventoryBundle}`,
    `WORKBENCH_DEERFLOW_PROVIDER_ENV_FILE=${providerEnv}`,
    `WORKBENCH_RUNTIME_WORKER_EXECUTION_PRIVATE_KEY_HOST_PATH=${privateKey}`,
    `WORKBENCH_RUNTIME_WORKER_UID=${ownerUid}`,
    `WORKBENCH_KNOWLEDGE_TOKENIZER_HOST_DIR=${modelRoot}`,
    "",
  ].join("\n"), { mode: 0o600 });

  try {
    run({
      environmentFile,
      inventory,
      inventoryBundle,
      privateKey,
      providerEnv,
      releaseRoot,
      root,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(fixture, {
  extraArguments = [],
  owner = ownerUid,
  releaseRoot = fixture.releaseRoot,
} = {}) {
  return spawnSync(process.execPath, [
    script,
    "--release-root", releaseRoot,
    "--env-file", fixture.environmentFile,
    "--owner-uid", String(owner),
    ...extraArguments,
  ], { encoding: "utf8" });
}

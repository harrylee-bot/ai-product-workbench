import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  parseCliArguments,
  REPRODUCIBILITY_SCHEMA_VERSION,
  verifyWorkbenchReproducibility,
  writeReproducibilityReceipt,
} from "./verify-workbench-reproducibility.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const tree = "c".repeat(40);
const tagObject = "d".repeat(40);
const tag = "workbench-r0-test";

test("requires explicit commit, tag, and output CLI bindings", () => {
  assert.throws(() => parseCliArguments([]), /--commit is required/);
  assert.throws(() => parseCliArguments(["--commit", commit]), /--tag is required/);
  assert.throws(
    () => parseCliArguments(["--commit", commit, "--tag", tag]),
    /--output is required/,
  );
  const parsed = parseCliArguments([
    "--commit", commit,
    "--tag", tag,
    "--output", "/tmp/receipt.json",
  ]);
  assert.equal(parsed.commit, commit);
  assert.equal(parsed.tag, tag);
  assert.equal(parsed.output, "/tmp/receipt.json");
});

test("fails closed when the verified tag peels to another commit", async (t) => {
  const fixture = await createFixture({
    responses: { "source.tag-peeled": `${otherCommit}\n` },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "TAG_COMMIT_MISMATCH");
  assert.equal(result.receipt.payload.binding.tag.verified, false);
  assert(fixture.calls.includes("source.tag-verify"), "cryptographic tag verification must run");
  assert(!fixture.calls.includes("clone.create"), "a mismatched tag must stop before cloning");
});

test("fails closed when git verify-tag rejects the signature", async (t) => {
  const fixture = await createFixture({
    responses: { "source.tag-verify": { exitCode: 1, stderr: "bad signature" } },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "COMMAND_FAILED");
  assert.equal(result.receipt.payload.failure.details.commandId, "source.tag-verify");
  assert.equal(result.receipt.payload.binding.tag.verified, false);
});

test("rejects any Node major other than 22", async (t) => {
  const fixture = await createFixture({
    responses: { "tool.node-version": "v21.7.3\n" },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "NODE_VERSION_UNSUPPORTED");
  assert.equal(result.receipt.payload.tools.node.commandVersion, "v21.7.3");
  assert(!fixture.calls.includes("clone.create"));
});

test("rejects tracked source changes after generation", async (t) => {
  const fixture = await createFixture({
    responses: {
      "generation-round-1.tracked-diff": "apps/web/lib/workbench/runtime.ts\0",
    },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "SOURCE_DIFF_DETECTED");
  assert.equal(result.receipt.payload.failure.details.phase, "generation-round-1");
  assert.deepEqual(result.receipt.payload.failure.details.unexpectedSample, [
    { path: "apps/web/lib/workbench/runtime.ts", state: "tracked" },
  ]);
  assert(!fixture.calls.includes("generation.2.prepare"));
});

test("rejects untracked source changes after generation", async (t) => {
  const fixture = await createFixture({
    responses: {
      "generation-round-1.untracked-files": "apps/web/lib/workbench/new-runtime.ts\0",
    },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.receipt.payload.failure.code, "SOURCE_DIFF_DETECTED");
  assert.deepEqual(result.receipt.payload.failure.details.unexpectedSample, [
    { path: "apps/web/lib/workbench/new-runtime.ts", state: "untracked" },
  ]);
});

test("detects ignored source instead of letting broad ignore rules hide it", async (t) => {
  const fixture = await createFixture({
    responses: {
      "generation-round-1.ignored-files": "apps/workbench-worker/src/storage/\0",
    },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.receipt.payload.failure.code, "SOURCE_DIFF_DETECTED");
  assert.deepEqual(result.receipt.payload.failure.details.unexpectedSample, [
    { path: "apps/workbench-worker/src/storage", state: "ignored" },
  ]);
});

test("allows only explicit generated paths without hiding source changes", async (t) => {
  const fixture = await createFixture({
    responses: {
      "generation-round-1.untracked-files": [
        "packages/workbench-db/generated/client.js",
        "apps/workbench-api/dist/main.js",
      ].join("\0") + "\0",
      "generation-round-2.untracked-files": "packages/workbench-db/generated/client.js\0",
      "post-checks.untracked-files": "apps/workbench-api/dist/main.js\0",
    },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, true);
  assert.equal(result.status, "PASS");
  assert.equal(result.receipt.payload.sourceAudits[1].untracked.allowedGeneratedCount, 2);
  assert.equal(result.receipt.payload.sourceAudits[1].untracked.unexpectedCount, 0);
});

test("success binds the signed tag, source tree, isolated clone, tools, and all default checks", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, true);
  assert.equal(result.status, "PASS");
  assert.equal(result.receipt.schemaVersion, REPRODUCIBILITY_SCHEMA_VERSION);
  assert.equal(result.receipt.payload.binding.sourceCommit, commit);
  assert.equal(result.receipt.payload.binding.sourceTree, tree);
  assert.equal(result.receipt.payload.binding.cloneCommit, commit);
  assert.equal(result.receipt.payload.binding.cloneTree, tree);
  assert.deepEqual(result.receipt.payload.binding.tag, {
    name: tag,
    objectId: tagObject,
    payloadSha256: sha256("signed tag payload\n"),
    peeledCommit: commit,
    verified: true,
  });
  assert.equal(result.receipt.payload.tools.node.major, 22);
  assert.deepEqual(result.receipt.payload.generationRounds.map((entry) => entry.status), ["PASS", "PASS"]);
  assert.deepEqual(result.receipt.payload.checks, [
    { id: "openapi", status: "PASS" },
    { id: "runtimeSchema", status: "PASS" },
    { id: "runtimeValidator", status: "PASS" },
    { id: "typecheck", status: "PASS" },
  ]);
  assert.equal(result.receipt.payload.isolation.cleanupStatus, "PASS");
  assert.equal(result.receipt.payload.failure, null);
  assert.equal(
    result.receipt.payloadSha256,
    sha256(canonicalJson({
      schemaVersion: result.receipt.schemaVersion,
      payload: result.receipt.payload,
    })),
  );
  assert.equal(fixture.calls.filter((id) => id.endsWith(".prepare")).length, 2);
  assert.equal(fixture.calls.filter((id) => id.endsWith(".brand-assets")).length, 2);
  for (const required of [
    "source.tag-verify",
    "clone.tag-verify",
    "install.npm-ci",
    "check.openapi",
    "check.runtimeSchema",
    "check.runtimeValidator",
    "check.typecheck",
  ]) assert(fixture.calls.includes(required), `missing command ${required}`);
  const cloneCommand = result.receipt.payload.commands.find((entry) => entry.id === "clone.create");
  assert(cloneCommand.args.includes("--no-hardlinks"));
  assert(cloneCommand.args.includes("--no-checkout"));
  assert(cloneCommand.args.includes("$SOURCE_REPOSITORY"));
  assert(cloneCommand.args.includes("$ISOLATED_CHECKOUT"));
});

test("explicitly skipped default checks make the receipt INCONCLUSIVE, never PASS", async (t) => {
  const fixture = await createFixture({ checks: { typecheck: false } });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.passed, false);
  assert.equal(result.status, "INCONCLUSIVE");
  assert.deepEqual(result.receipt.payload.skippedChecks, ["typecheck"]);
  const command = result.receipt.payload.commands.find((entry) => entry.id === "check.typecheck");
  assert.equal(command.status, "NOT_RUN");
});

test("writes canonical receipt and a SHA-256 sidecar without overwriting", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  const output = path.join(fixture.root, "evidence", "receipt.json");
  const written = await writeReproducibilityReceipt(
    output,
    result.receipt,
    result.evidenceArtifacts,
  );
  const raw = await readFile(output, "utf8");
  const sidecar = await readFile(`${output}.sha256`, "utf8");
  const nodeCommand = result.receipt.payload.commands.find((entry) => entry.id === "tool.node-version");
  const nodeArtifactPath = resolveEvidenceUri(output, nodeCommand.stdout.artifact.uri);
  const nodeArtifact = await readFile(nodeArtifactPath);
  assert.equal(raw, `${canonicalJson(result.receipt)}\n`);
  assert.equal(written.receiptSha256, sha256(raw));
  assert.equal(sidecar, `${sha256(raw)}  receipt.json\n`);
  assert.equal(nodeArtifact.toString("utf8"), "v22.22.0\n");
  assert.equal(nodeCommand.stdout.artifact.sha256, sha256(nodeArtifact));
  assert.equal(nodeCommand.stdout.artifact.byteSize, nodeArtifact.length);
  assert.equal(nodeCommand.stderr.artifact, null);
  assert.equal(nodeCommand.stderr.redactionWarning, null);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(`${output}.sha256`)).mode & 0o777, 0o600);
  assert.equal((await stat(nodeArtifactPath)).mode & 0o777, 0o600);
  assert.equal((await stat(written.evidenceDirectoryPath)).mode & 0o777, 0o700);
  await assert.rejects(
    writeReproducibilityReceipt(output, result.receipt, result.evidenceArtifacts),
    /refusing to overwrite/,
  );
});

test("rejects tampered in-memory command evidence without leaving a partial package", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  const rawArtifact = result.evidenceArtifacts.find((entry) => entry.kind === "raw-command-output");
  rawArtifact.bytes = Buffer.from("tampered command output\n");
  const output = path.join(fixture.root, "tamper", "receipt.json");
  await assert.rejects(
    writeReproducibilityReceipt(output, result.receipt, result.evidenceArtifacts),
    /integrity mismatch/,
  );
  await assert.rejects(stat(output), { code: "ENOENT" });
  await assert.rejects(stat(`${output}.sha256`), { code: "ENOENT" });
  await assert.rejects(stat(`${output}.evidence`), { code: "ENOENT" });
});

test("secret-like command output becomes a redacted warning artifact and forces FAIL", async (t) => {
  const secret = "Bearer abcdefghijklmnopqrstuvwxyz012345";
  const fixture = await createFixture({
    responses: {
      "source.tag-verify": { exitCode: 0, stderr: `Authorization: ${secret}\n` },
    },
  });
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  assert.equal(result.status, "FAIL");
  assert.equal(result.receipt.payload.failure.code, "COMMAND_OUTPUT_SECRET_DETECTED");
  const command = result.receipt.payload.commands.find((entry) => entry.id === "source.tag-verify");
  assert.equal(command.status, "FAIL");
  assert.equal(command.stderr.secretScan.status, "BLOCKED");
  assert.equal(command.stderr.artifact, null);
  assert(command.stderr.redactionWarning);
  assert(command.stderr.secretScan.findingIds.includes("bearer-credential"));
  const output = path.join(fixture.root, "secret", "receipt.json");
  await writeReproducibilityReceipt(output, result.receipt, result.evidenceArtifacts);
  const warning = await readFile(resolveEvidenceUri(output, command.stderr.redactionWarning.uri), "utf8");
  const receipt = await readFile(output, "utf8");
  assert(!warning.includes(secret));
  assert(!receipt.includes(secret));
  assert.equal(JSON.parse(warning).status, "REDACTED");
  assert.equal(sha256(warning), command.stderr.redactionWarning.sha256);
});

test("pre-existing evidence directory is never overwritten and no half-package is published", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const result = await fixture.verify();
  const output = path.join(fixture.root, "occupied", "receipt.json");
  const evidenceDirectory = `${output}.evidence`;
  await mkdir(evidenceDirectory, { recursive: true });
  const sentinel = path.join(evidenceDirectory, "sentinel.txt");
  await writeFile(sentinel, "existing\n", "utf8");
  await assert.rejects(
    writeReproducibilityReceipt(output, result.receipt, result.evidenceArtifacts),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(sentinel, "utf8"), "existing\n");
  await assert.rejects(stat(output), { code: "ENOENT" });
  await assert.rejects(stat(`${output}.sha256`), { code: "ENOENT" });
});

async function createFixture({ responses = {}, checks = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-reproducibility-test-"));
  const repoRoot = path.join(root, "repository");
  const tempParent = path.join(root, "temporary");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(tempParent, { recursive: true });
  const calls = [];
  const runner = async (specification) => {
    calls.push(specification.id);
    if (specification.id === "clone.create") {
      await mkdir(specification.args.at(-1), { recursive: true });
    }
    const configured = responses[specification.id];
    if (configured !== undefined) return commandResult(configured);
    return commandResult(defaultResponse(specification.id, repoRoot));
  };
  let timestamp = 0;
  return {
    root,
    repoRoot,
    calls,
    verify: () => verifyWorkbenchReproducibility({
      repoRoot,
      commit,
      tag,
      checks,
      commandRunner: runner,
      processNodeVersion: "v22.22.0",
      tempParent,
      now: () => `2026-07-19T00:00:0${timestamp++}Z`,
      platform: "test-os",
      architecture: "test-arch",
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function defaultResponse(id, repoRoot) {
  const responses = {
    "source.repository-root": `${repoRoot}\n`,
    "source.commit": `${commit}\n`,
    "source.tree": `${tree}\n`,
    "source.tag-object": `${tagObject}\n`,
    "source.tag-type": "tag\n",
    "source.tag-verify": "",
    "source.tag-peeled": `${commit}\n`,
    "source.tag-payload": "signed tag payload\n",
    "tool.git-version": "git version 2.50.1\n",
    "tool.node-version": "v22.22.0\n",
    "tool.npm-version": "10.9.3\n",
    "clone.commit": `${commit}\n`,
    "clone.tree": `${tree}\n`,
    "clone.tag-object": `${tagObject}\n`,
    "clone.tag-peeled": `${commit}\n`,
    "clone.tag-verify": "",
  };
  return responses[id] ?? "";
}

function commandResult(value) {
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return {
      exitCode: value.exitCode ?? 0,
      signal: value.signal ?? null,
      errorCode: value.errorCode ?? null,
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
    };
  }
  return { exitCode: 0, signal: null, errorCode: null, stdout: value, stderr: "" };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveEvidenceUri(receiptPath, uri) {
  assert.match(uri, /^file:\.\//u);
  return path.join(path.dirname(receiptPath), uri.slice("file:./".length));
}

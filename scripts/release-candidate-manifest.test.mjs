import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  link as linkFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import Ajv2020 from "@redocly/ajv/dist/2020.js";

import {
  canonicalJson,
  createReleaseCandidateManifest,
  normalizeReleaseMetadata,
} from "./release-candidate-manifest-lib.mjs";
import { writeImmutableArtifactSet } from "./release-candidate-manifest.mjs";

const execFileAsync = promisify(execFile);
const FIXED_AUDIT = Object.freeze({
  startedAt: "2026-07-18T01:00:00Z",
  endedAt: "2026-07-18T01:05:00Z",
  executor: "release-automation@example.test",
  verifier: "evidence-custodian@example.test",
});
const VALID_RELEASE_METADATA = Object.freeze({
  environmentId: "test-environment",
  deployId: "test-deploy",
  configRevision: "test-config-r1",
  postgresVersion: "16.4",
  pgvectorVersion: "0.8.0",
  deerFlow: Object.freeze({
    sourceCommit: "1".repeat(40),
    baseImageDigest: `sha256:${"2".repeat(64)}`,
    overlayConfigSha256: "3".repeat(64),
  }),
  images: Object.freeze({}),
  artifacts: Object.freeze({}),
});

test("canonicalJson sorts object keys recursively and rejects unsupported values", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 4, b: [3, { y: true, x: null }] } }), '{"a":{"b":[3,{"x":null,"y":true}],"d":4},"z":1}');
  assert.throws(() => canonicalJson({ invalid: undefined }), /does not support undefined/);
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /non-finite/);
});

test("requires complete release metadata and explicit empty R0 digest maps", () => {
  assert.deepEqual(normalizeReleaseMetadata(VALID_RELEASE_METADATA), VALID_RELEASE_METADATA);
  assert.throws(() => normalizeReleaseMetadata(undefined), /releaseMetadata must be an object/);

  for (const field of [
    "environmentId",
    "deployId",
    "configRevision",
    "postgresVersion",
    "pgvectorVersion",
    "deerFlow",
    "images",
    "artifacts",
  ]) {
    const candidate = structuredClone(VALID_RELEASE_METADATA);
    delete candidate[field];
    assert.throws(() => normalizeReleaseMetadata(candidate), new RegExp(`releaseMetadata\\.${field}`));
  }
  for (const field of ["sourceCommit", "baseImageDigest", "overlayConfigSha256"]) {
    const candidate = structuredClone(VALID_RELEASE_METADATA);
    delete candidate.deerFlow[field];
    assert.throws(() => normalizeReleaseMetadata(candidate), new RegExp(`releaseMetadata\\.deerFlow\\.${field}`));
  }
});

test("rejects mutable or malformed release digests", () => {
  const cases = [
    ["sourceCommit", (value) => { value.deerFlow.sourceCommit = "not-a-commit"; }],
    ["baseImageDigest", (value) => { value.deerFlow.baseImageDigest = "deerflow:latest"; }],
    ["overlayConfigSha256", (value) => { value.deerFlow.overlayConfigSha256 = `sha256:${"3".repeat(64)}`; }],
    ["images.api", (value) => { value.images.api = "workbench-api:latest"; }],
    ["artifacts.sbom", (value) => { value.artifacts.sbom = "4".repeat(64); }],
  ];
  for (const [field, mutate] of cases) {
    const candidate = structuredClone(VALID_RELEASE_METADATA);
    mutate(candidate);
    assert.throws(() => normalizeReleaseMetadata(candidate), new RegExp(field.replace(".", "\\.")));
  }

  const legacyDerivedImage = structuredClone(VALID_RELEASE_METADATA);
  delete legacyDerivedImage.deerFlow.baseImageDigest;
  legacyDerivedImage.deerFlow.imageDigest = `sha256:${"2".repeat(64)}`;
  assert.throws(
    () => normalizeReleaseMetadata(legacyDerivedImage),
    /releaseMetadata\.deerFlow\.imageDigest is not supported/u,
  );
});

test("CLI treats a missing metadata file argument as invalid invocation", async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-candidate-metadata-cli-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const cliPath = fileURLToPath(new URL("./release-candidate-manifest.mjs", import.meta.url));
  await assert.rejects(execFileAsync(process.execPath, [
    cliPath,
    "--manifest-output", path.join(outputRoot, "candidate.json"),
    "--inventory-output", path.join(outputRoot, "inventory.ndjson"),
  ], { encoding: "utf8" }), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /--metadata-file is required/);
    return true;
  });
  assert.deepEqual(await readdir(outputRoot), []);
});

test("writes immutable artifacts with SHA-256 sidecars and never overwrites", async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-candidate-output-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const manifestOutput = path.join(outputRoot, "candidate.json");
  const inventoryOutput = path.join(outputRoot, "inventory.ndjson");
  const manifestContent = '{"candidateId":"fixture"}\n';
  const inventoryContent = '{"path":"README.md"}\n';

  const receipt = await writeImmutableArtifactSet({
    manifestOutput,
    inventoryOutput,
    manifestContent,
    inventoryContent,
  });

  assert.equal(await readFile(manifestOutput, "utf8"), manifestContent);
  assert.equal(await readFile(inventoryOutput, "utf8"), inventoryContent);
  assert.equal(await readFile(`${manifestOutput}.sha256`, "utf8"), `${sha256(manifestContent)}  candidate.json\n`);
  assert.equal(await readFile(`${inventoryOutput}.sha256`, "utf8"), `${sha256(inventoryContent)}  inventory.ndjson\n`);
  assert.equal(receipt.manifest.sha256, sha256(manifestContent));
  for (const fileName of ["candidate.json", "candidate.json.sha256", "inventory.ndjson", "inventory.ndjson.sha256"]) {
    assert.equal((await stat(path.join(outputRoot, fileName))).mode & 0o777, 0o600);
  }

  await assert.rejects(writeImmutableArtifactSet({
    manifestOutput,
    inventoryOutput,
    manifestContent: "replacement\n",
    inventoryContent: "replacement\n",
  }), /immutable artifact already exists/);
  assert.equal(await readFile(manifestOutput, "utf8"), manifestContent);

  const secondManifest = path.join(outputRoot, "second.json");
  const secondInventory = path.join(outputRoot, "second.ndjson");
  await writeFile(`${secondManifest}.sha256`, "pre-existing-sidecar\n", { mode: 0o600 });
  await assert.rejects(writeImmutableArtifactSet({
    manifestOutput: secondManifest,
    inventoryOutput: secondInventory,
    manifestContent,
    inventoryContent,
  }), /immutable artifact already exists/);
  assert.equal(await readFile(`${secondManifest}.sha256`, "utf8"), "pre-existing-sidecar\n");
  await assert.rejects(stat(secondManifest), { code: "ENOENT" });
  await assert.rejects(stat(secondInventory), { code: "ENOENT" });
});

test("rolls back every artifact created before a partial commit failure", async (t) => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "release-candidate-rollback-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const manifestOutput = path.join(outputRoot, "candidate.json");
  const inventoryOutput = path.join(outputRoot, "inventory.ndjson");
  let linkCount = 0;

  await assert.rejects(writeImmutableArtifactSet({
    manifestOutput,
    inventoryOutput,
    manifestContent: "manifest\n",
    inventoryContent: "inventory\n",
    linkFile: async (sourcePath, targetPath) => {
      linkCount += 1;
      if (linkCount === 3) {
        const error = new Error("injected link failure");
        error.code = "EIO";
        throw error;
      }
      await linkFile(sourcePath, targetPath);
    },
  }), /injected link failure/);

  assert.equal(linkCount, 3);
  assert.deepEqual(await readdir(outputRoot), []);
});

test("creates byte-identical manifest and inventory for the same repository snapshot", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(fixture.cleanup);

  const first = await capture(fixture.root);
  const second = await capture(fixture.root);

  assert.equal(first.manifestJson, second.manifestJson);
  assert.equal(first.inventoryNdjson, second.inventoryNdjson);
  assert.equal(first.manifest.candidateId, second.manifest.candidateId);
  assert.equal(first.manifest.inventory.sha256, sha256(first.inventoryNdjson));
  assert.equal(first.manifest.status.clean, true);
  assert.equal(first.manifest.criticalArtifacts.migrations.entryCount, 1);
  assert.equal(first.manifest.criticalArtifacts.migrations.status, "complete");
  assert.equal(first.manifest.criticalArtifacts.generatedContracts.entryCount, 4);
  assert.equal(first.manifest.criticalArtifacts.knowledgeVaultConfiguration.entryCount, 4);
  assert.equal(first.manifest.criticalArtifacts.remediationControl.entryCount, 2);
  assert.ok(first.manifest.criticalArtifacts.evidenceContracts.entryCount >= 2);
  assert.ok(first.manifest.sourceScopes.every((scope) => scope.status === "complete"));
  assert.equal(first.manifest.sourceScopes.find((scope) => scope.name === "runbooks")?.entryCount, 1);
  assert.equal(first.manifest.signedTag.verified, true);
  assert.equal(first.manifest.sourceCommitSignature.verified, true);
  assert.equal(first.manifest.gate.status, "PASS");
  assert.deepEqual(first.manifest.findings, []);
  const schema = JSON.parse(await readFile(new URL("../schemas/release-candidate-manifest.schema.json", import.meta.url), "utf8"));
  const validateManifest = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validateManifest(first.manifest), true, JSON.stringify(validateManifest.errors));
  assert.deepEqual(Object.keys(first.manifest).sort(), Object.keys(schema.properties).sort());
  assert.ok(schema.required.every((property) => Object.hasOwn(first.manifest, property)));
});

test("fails closed for untracked and ignored runtime-critical files", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(fixture.cleanup);
  await writeFixtureFile(fixture.root, "apps/workbench-api/src/untracked-runtime.ts", "export const value = 1;\n");
  await writeFixtureFile(fixture.root, "deploy/private/runtime.conf", "runtime-only=true\n");
  await rm(path.join(fixture.root, "apps/workbench-preview/src/index.ts"));

  const result = await capture(fixture.root);
  const findings = result.manifest.findings;
  assert.ok(findings.some((finding) => finding.code === "UNTRACKED_CRITICAL_FILE"
    && finding.path === "apps/workbench-api/src/untracked-runtime.ts"));
  assert.ok(findings.some((finding) => finding.code === "IGNORED_CRITICAL_FILE"
    && finding.path === "deploy/private/runtime.conf"));
  assert.ok(findings.some((finding) => finding.code === "INVENTORY_FILE_UNREADABLE"
    && finding.path === "apps/workbench-preview/src/index.ts"));
  assert.equal(result.manifestJson.includes(fixture.root), false);
  assert.equal(result.manifest.gate.status, "FAIL");

  const inventory = parseNdjson(result.inventoryNdjson);
  assert.equal(inventory.find((entry) => entry.path === "apps/workbench-api/src/untracked-runtime.ts")?.disposition, "blocked");
  assert.equal(inventory.find((entry) => entry.path === "deploy/private/runtime.conf")?.disposition, "blocked");
});

test("excludes ignored TypeScript incremental build metadata", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(fixture.cleanup);
  await writeFixtureFile(fixture.root, "apps/web/tsconfig.tsbuildinfo", "generated\n");

  const result = await capture(fixture.root);
  const entry = parseNdjson(result.inventoryNdjson).find((item) => item.path === "apps/web/tsconfig.tsbuildinfo");
  assert.deepEqual({ disposition: entry.disposition, reasonCode: entry.reasonCode }, {
    disposition: "excluded",
    reasonCode: "typescriptBuildInfo",
  });
  assert.equal(result.manifest.findings.some((finding) => finding.path === "apps/web/tsconfig.tsbuildinfo"), false);
});

test("never reads secret-like file content into evidence and blocks the candidate", async (t) => {
  const fixture = await createRepositoryFixture();
  t.after(fixture.cleanup);
  const secretValue = "WORKBENCH_SECRET=do-not-copy-this-value";
  await writeFixtureFile(fixture.root, ".env", `${secretValue}\n`);

  const result = await capture(fixture.root);
  assert.ok(result.manifest.findings.some((finding) => finding.code === "SECRET_MATERIAL_PRESENT"
    && finding.path === ".env"));
  assert.equal(result.manifestJson.includes(secretValue), false);
  assert.equal(result.inventoryNdjson.includes(secretValue), false);
  const secretEntry = parseNdjson(result.inventoryNdjson).find((entry) => entry.path === ".env");
  assert.deepEqual({ disposition: secretEntry.disposition, sha256: secretEntry.sha256, byteSize: secretEntry.byteSize }, {
    disposition: "blocked",
    sha256: null,
    byteSize: null,
  });
});

test("binds only knowledge-vault referenced storage and explicitly excludes orphan assets", async (t) => {
  const referenced = Buffer.from("referenced knowledge asset\n", "utf8");
  const fixture = await createRepositoryFixture({
    referencedAsset: referenced,
    orphanAsset: Buffer.from("orphan asset\n", "utf8"),
  });
  t.after(fixture.cleanup);

  const result = await capture(fixture.root);
  assert.equal(result.manifest.knowledgeStorage.auditPassed, true);
  assert.equal(result.manifest.knowledgeStorage.referencedAssetCount, 1);
  assert.deepEqual(result.manifest.knowledgeStorage.referencedAssets.map((asset) => ({
    path: asset.path,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
  })), [{
    path: "storage/source-assets/referenced.bin",
    byteSize: referenced.length,
    sha256: sha256(referenced),
  }]);

  const inventory = parseNdjson(result.inventoryNdjson);
  const referencedEntry = inventory.find((entry) => entry.path === "storage/source-assets/referenced.bin");
  const orphanEntry = inventory.find((entry) => entry.path === "storage/imports/orphan.bin");
  assert.deepEqual({
    disposition: referencedEntry.disposition,
    reasonCode: referencedEntry.reasonCode,
    byteSize: referencedEntry.byteSize,
    sha256: referencedEntry.sha256,
  }, {
    disposition: "external",
    reasonCode: "referencedKnowledgeStorageAsset",
    byteSize: referenced.length,
    sha256: sha256(referenced),
  });
  assert.deepEqual({
    disposition: orphanEntry.disposition,
    reasonCode: orphanEntry.reasonCode,
    sha256: orphanEntry.sha256,
  }, {
    disposition: "excluded",
    reasonCode: "unreferencedStorageAsset",
    sha256: null,
  });
});

async function capture(repoRoot) {
  return createReleaseCandidateManifest({
    repoRoot,
    audit: FIXED_AUDIT,
    signedTag: "candidate-v1",
    expectedMigrationCount: 1,
    releaseMetadata: VALID_RELEASE_METADATA,
    knowledgeAuditOptions: {
      requiredFiles: [],
      unreferencedSampleLimit: 10,
    },
  });
}

async function createRepositoryFixture({ referencedAsset = null, orphanAsset = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "release-candidate-manifest-"));
  const signingRoot = await mkdtemp(path.join(tmpdir(), "release-candidate-signing-"));
  const files = new Map([
    [".dockerignore", "node_modules\n.env*\nstorage/**\n"],
    [".gitignore", "node_modules\n/storage/\n.env\ndeploy/private/\n**/dist/\n**/.next/\n*.tsbuildinfo\n"],
    [".npmrc", "engine-strict=true\n"],
    [".env.example", "WORKBENCH_SECRET=replace-me\n"],
    [".dependency-cruiser.cjs", "module.exports = {};\n"],
    ["README.md", "# Fixture candidate\n"],
    ["package.json", '{"name":"fixture","private":true}\n'],
    ["package-lock.json", '{"name":"fixture","lockfileVersion":3,"packages":{}}\n'],
    ["tsconfig.base.json", "{}\n"],
    [".github/workflows/ci.yml", "name: candidate\n"],
    ["deploy/workbench-compose.yml", "services: {}\n"],
    ["docs/runbooks/production-acceptance.md", "# Production acceptance\n"],
    ["docs/evidence/ledger.schema.json", "{}\n"],
    ["apps/web/app/page.tsx", "export default function Page() { return null; }\n"],
    ["apps/web/app/icon.png", "icon\n"],
    ["apps/web/app/favicon.ico", "favicon\n"],
    ["apps/web/public/brand/logo.txt", "产品工作台\n"],
    ["apps/knowledge/quartz.config.yaml", "configuration: fixture\n"],
    ["apps/workbench-api/src/index.ts", "export {};\n"],
    ["apps/workbench-worker/src/index.ts", "export {};\n"],
    ["apps/workbench-file-worker/src/index.ts", "export {};\n"],
    ["apps/workbench-import-worker/src/index.ts", "export {};\n"],
    ["apps/workbench-export-worker/src/index.ts", "export {};\n"],
    ["apps/workbench-preview/src/index.ts", "export {};\n"],
    ["apps/workbench-figma-importer/src/main.ts", "export {};\n"],
    ["packages/workbench-contracts/openapi/baseline/workbench.v1.yaml", "openapi: 3.1.0\n"],
    ["packages/workbench-contracts/openapi/workbench.v1.yaml", "openapi: 3.1.0\n"],
    ["packages/workbench-canvas-tools/src/index.ts", "export {};\n"],
    ["packages/workbench-db/prisma/schema.prisma", "generator client { provider = \"prisma-client-js\" }\n"],
    ["packages/workbench-db/prisma/migrations/20260718000000_fixture/migration.sql", "SELECT 1;\n"],
    ["integrations/deerflow/README.md", "# DeerFlow\n"],
    ["integrations/deerflow/skills/workbench/references/runtime-result.schema.json", "{}\n"],
    ["integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs", "export {};\n"],
    ["scripts/workbench-hard-cut-manifest.mjs", "export {};\n"],
    ["docs/workbench-hard-cut-deletion-manifest.json", "{}\n"],
    ["docs/CODEX-WORKBENCH-COMPREHENSIVE-AUDIT-REMEDIATION.md", "# Remediation control\n"],
    ["schemas/release-candidate-manifest.schema.json", "{}\n"],
    ["knowledge-vault/.obsidian/app.json", "{}\n"],
    ["knowledge-vault/.obsidian/core-plugins.json", "[]\n"],
    ["knowledge-vault/.obsidian/graph.json", "{}\n"],
    ["knowledge-vault/.obsidian/templates.json", "{}\n"],
  ]);
  const referencedSha256 = referencedAsset ? sha256(referencedAsset) : null;
  files.set("knowledge-vault/README.md", knowledgeMarkdown({
    referencedSha256,
    referencedByteSize: referencedAsset?.length ?? null,
  }));
  for (const [relativePath, content] of files) await writeFixtureFile(root, relativePath, content);
  await mkdir(path.join(root, "storage", "source-assets"), { recursive: true });
  await mkdir(path.join(root, "storage", "imports"), { recursive: true });
  if (referencedAsset) await writeFixtureFile(root, "storage/source-assets/referenced.bin", referencedAsset);
  if (orphanAsset) await writeFixtureFile(root, "storage/imports/orphan.bin", orphanAsset);

  await git(root, ["init", "-b", "release/candidate"]);
  await git(root, ["config", "user.name", "Candidate Test"]);
  await git(root, ["config", "user.email", "candidate@example.test"]);
  const signingKey = path.join(signingRoot, "candidate-signing-key");
  const allowedSigners = path.join(signingRoot, "allowed-signers");
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
  const publicKey = (await readFile(`${signingKey}.pub`, "utf8")).trim();
  await writeFile(allowedSigners, `candidate@example.test ${publicKey}\n`, "utf8");
  await git(root, ["config", "gpg.format", "ssh"]);
  await git(root, ["config", "user.signingkey", signingKey]);
  await git(root, ["config", "gpg.ssh.allowedSignersFile", allowedSigners]);
  await git(root, ["config", "commit.gpgsign", "true"]);
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", "fixture candidate"]);
  await git(root, ["tag", "-s", "candidate-v1", "-m", "signed fixture tag"]);
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
      await rm(signingRoot, { recursive: true, force: true });
    },
  };
}

async function writeFixtureFile(root, relativePath, content) {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

function parseNdjson(value) {
  return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function knowledgeMarkdown({ referencedSha256, referencedByteSize }) {
  const reference = referencedSha256
    ? `\nSource asset: \`storage/source-assets/referenced.bin\`\n\nSHA-256: \`${referencedSha256}\`\n\nbyteSize: ${referencedByteSize} bytes\n`
    : "";
  return `---
title: Candidate fixture knowledge
description: Candidate fixture used for release provenance tests.
status: active
tags:
  - release
---

# Candidate fixture knowledge

${"Deterministic knowledge content for the release candidate. ".repeat(4)}
${reference}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

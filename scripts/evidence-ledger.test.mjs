import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  DISCOVERY_STATUSES,
  EVIDENCE_LEVELS,
  EXECUTION_STATUSES,
  EvidenceValidationError,
  sealEvidenceIndex,
  sealEvidenceLedger,
  sha256Bytes,
  verifyEvidenceIndex,
  verifyEvidenceLedger,
} from "./evidence-ledger.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const verifierPath = path.join(scriptDir, "evidence-ledger.mjs");
const repositoryRoot = path.resolve(scriptDir, "..");
const committedFixtureRoot = path.join(scriptDir, "fixtures/evidence-ledger/valid");
const expectedBinding = Object.freeze({
  candidateId: "rc-20260718-01",
  deployId: "deploy-20260718-01",
  environmentId: "production-cn-hz",
});
const commitSha = "1".repeat(40);
const configSha256 = "2".repeat(64);
const migrationSha256 = "3".repeat(64);
const deploymentConfigManifestSha256 = "8".repeat(64);
const imageDigest = `sha256:${"4".repeat(64)}`;

test("keeps the committed reference fixture fully verifiable", async () => {
  const fixtureBinding = {
    candidateId: "rc-20260718-fixture",
    deployId: "deploy-20260718-fixture",
    environmentId: "ci-fixture",
  };
  const report = await verifyEvidenceIndex({
    indexPath: "index.json",
    root: committedFixtureRoot,
    expectedBinding: fixtureBinding,
    candidateManifestPath: "candidate-manifest.json",
  });
  assert.equal(report.ok, true);
  assert.equal(report.ledgers[0].ledgerId, "ledger-20260718-fixture");
});

test("verifies a sealed ledger and reference-only index against explicit binding", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const ledger = await verifyEvidenceLedger({
    ledgerPath: fixture.ledgerPath,
    root: fixture.root,
    expectedBinding,
    candidateManifestPath: fixture.manifestPath,
  });
  assert.equal(ledger.ok, true);
  assert.equal(ledger.ledgerId, "ledger-20260718-01");
  assert.equal(ledger.entries, 1);
  assert.equal(ledger.localEvidenceFiles, 1);

  const index = await verifyEvidenceIndex({
    indexPath: fixture.indexPath,
    root: fixture.root,
    expectedBinding,
    candidateManifestPath: fixture.manifestPath,
  });
  assert.equal(index.ok, true);
  assert.equal(index.indexId, "index-20260718-01");
  assert.equal(index.ledgers.length, 1);
  assert.deepEqual(Object.keys(fixture.index.payload.ledgerReferences[0]).sort(), ["ledgerId", "sha256", "uri"]);
});

test("verifies an external candidate manifest cache against a content-addressed ledger reference", async (t) => {
  const fixture = await createFixture();
  const externalRoot = await mkdtemp(path.join(tmpdir(), "workbench-external-candidate-manifest-"));
  t.after(fixture.cleanup);
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const externalManifestPath = path.join(externalRoot, "release-candidate.json");
  const manifestRaw = await readFile(fixture.manifestPath);
  const manifestSha256 = sha256Bytes(manifestRaw);
  await writeFile(externalManifestPath, manifestRaw);
  await fixture.rewriteLedger((payload) => {
    payload.binding.candidateManifest = {
      sha256: manifestSha256,
      uri: `urn:sha256:${manifestSha256}`,
    };
  });

  const report = await verifyEvidenceLedger({
    ledgerPath: fixture.ledgerPath,
    root: fixture.root,
    expectedBinding,
    candidateManifestPath: externalManifestPath,
  });
  assert.equal(report.ok, true);
});

test("CLI requires external candidate, deploy, and environment identity", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const result = spawnSync(process.execPath, [
    verifierPath,
    "--root", fixture.root,
    "--index", "index.json",
    "--candidate-id", expectedBinding.candidateId,
    "--deploy-id", expectedBinding.deployId,
    "--environment-id", expectedBinding.environmentId,
    "--candidate-manifest", "candidate-manifest.json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);

  const missingBinding = spawnSync(process.execPath, [
    verifierPath,
    "--root", fixture.root,
    "--ledger", "ledger.json",
  ], { encoding: "utf8" });
  assert.notEqual(missingBinding.status, 0);
  assert.match(missingBinding.stderr, /--candidate-id is required/);
});

test("accepts every specified discovery status, execution status, and evidence level", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const entries = [];
  let sequence = 0;
  for (const findingStatus of DISCOVERY_STATUSES) {
    for (const executionStatus of EXECUTION_STATUSES) {
      for (const evidenceLevel of EVIDENCE_LEVELS) {
        sequence += 1;
        const entry = baseEntry(fixture.rawSha256, `entry-${String(sequence).padStart(3, "0")}`);
        entry.findingStatus = findingStatus;
        entry.executionStatus = executionStatus;
        entry.evidenceLevel = evidenceLevel;
        if (executionStatus === "N/A") {
          entry.notApplicable = {
            approver: "auditor-01",
            expiresAtUtc: "2026-08-18T00:00:00Z",
            scopeBasis: "This gate is outside the frozen candidate scope.",
          };
        }
        entries.push(entry);
      }
    }
  }
  await fixture.rewriteLedger((payload) => { payload.entries = entries; });

  const report = await verifyEvidenceLedger({
    ledgerPath: fixture.ledgerPath,
    root: fixture.root,
    expectedBinding,
  });
  assert.equal(report.entries, DISCOVERY_STATUSES.length * EXECUTION_STATUSES.length * EVIDENCE_LEVELS.length);
});

test("allows an honest empty image digest inventory before images are built", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.binding.digests.images = [];
    payload.entries[0].binding.digests.images = [];
  });

  const report = await fixture.verifyLedger();
  assert.deepEqual(report.binding.digests.images, []);
});

test("seal and canonical JSON are deterministic across object and sortable array order", async () => {
  const firstEntry = baseEntry("a".repeat(64), "entry-002");
  const secondEntry = baseEntry("a".repeat(64), "entry-001");
  firstEntry.toolVersions = [
    { version: "2.0.0", name: "z-tool" },
    { version: "1.0.0", name: "a-tool" },
  ];
  const payload = basePayload("b".repeat(64));
  payload.entries = [firstEntry, secondEntry];
  const left = sealEvidenceLedger(payload);
  const differentlyOrdered = reverseObjectKeyOrder(payload);
  differentlyOrdered.entries.reverse();
  differentlyOrdered.entries.find((entry) => entry.entryId === "entry-002").toolVersions.reverse();
  const right = sealEvidenceLedger(differentlyOrdered);

  assert.equal(left.payload.entries[0].entryId, "entry-001");
  assert.deepEqual(left.payload.entries[1].toolVersions.map((tool) => tool.name), ["a-tool", "z-tool"]);
  assert.deepEqual(right, left);
  assert.equal(left.payloadSha256, sealEvidenceLedger(payload).payloadSha256);
  assert.match(canonicalJsonFile(left), /\n$/);
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.notEqual(right.payloadSha256, "");
});

test("rejects canonical ledger payload tampering without a new seal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].executionStatus = "FAIL";
  }, { reseal: false });

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /ledger payload SHA-256 mismatch/,
  );
});

test("rejects changed raw evidence even when the ledger remains sealed", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await writeFile(fixture.rawPath, "gate=false\n", "utf8");

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /entry entry-001 evidence SHA-256 mismatch/,
  );
});

test("rejects nonexistent local evidence", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await unlink(fixture.rawPath);

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /entry entry-001 evidence does not exist/,
  );
});

test("rejects the wrong externally expected candidate binding", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await assertValidationFailure(
    () => verifyEvidenceLedger({
      ledgerPath: fixture.ledgerPath,
      root: fixture.root,
      expectedBinding: { ...expectedBinding, candidateId: "rc-wrong-candidate" },
    }),
    /ledger binding candidateId mismatch/,
  );
});

test("rejects an entry whose candidate binding diverges from its ledger", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].binding.candidateId = "rc-other-candidate";
  });

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /entry entry-001 candidateId does not match the ledger binding/,
  );
});

test("rejects a candidate manifest whose identity contradicts the sealed binding", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const changedManifest = canonicalJsonFile({
    candidateId: "rc-other-candidate",
    sourceCommit: commitSha,
    tag: "workbench-v1.0.0-rc.1",
    deployId: expectedBinding.deployId,
    environmentId: expectedBinding.environmentId,
  });
  await writeFile(fixture.manifestPath, changedManifest, "utf8");
  const changedSha256 = sha256Bytes(changedManifest);
  await fixture.rewriteLedger((payload) => {
    payload.binding.candidateManifest.sha256 = changedSha256;
  });

  await assertValidationFailure(
    () => verifyEvidenceLedger({
      ledgerPath: fixture.ledgerPath,
      root: fixture.root,
      expectedBinding,
      candidateManifestPath: fixture.manifestPath,
    }),
    /candidate manifest candidateId mismatch/,
  );
});

test("rejects a candidate manifest source commit or tag that contradicts the ledger", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const changedManifest = canonicalJsonFile({
    candidateId: expectedBinding.candidateId,
    sourceCommit: "9".repeat(40),
    signedTag: { name: "workbench-v1.0.0-other" },
    deployId: expectedBinding.deployId,
    environmentId: expectedBinding.environmentId,
  });
  await writeFile(fixture.manifestPath, changedManifest, "utf8");
  await fixture.rewriteLedger((payload) => {
    payload.binding.candidateManifest.sha256 = sha256Bytes(changedManifest);
  });

  await assertValidationFailure(
    () => verifyEvidenceLedger({
      ledgerPath: fixture.ledgerPath,
      root: fixture.root,
      expectedBinding,
      candidateManifestPath: fixture.manifestPath,
    }),
    /candidate manifest commitSha mismatch/,
  );
});

test("rejects a mutable evidence URI even when the payload has a valid new seal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].evidence[0].uri = "https://evidence.example.test/latest/gate.log";
  });

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /HTTPS URI is mutable/,
  );
});

test("rejects signed evidence URLs that embed reusable credentials", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].evidence[0].uri = "s3://evidence/g0.log?versionId=immutable-v1&X-Amz-Signature=TEST_ONLY_PLACEHOLDER";
  });

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /must not contain signed URL or credential query parameters/,
  );
});

test("rejects credentials in raw evidence after hash verification", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const leaked = "authorization: Bearer TEST_ONLY_PLACEHOLDER_NOT_A_SECRET\n";
  await writeFile(fixture.rawPath, leaked, "utf8");
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].evidence[0].sha256 = sha256Bytes(leaked);
  });

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /possible bearer credential/,
  );
});

test("rejects an index that duplicates ledger status", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const payload = structuredClone(fixture.index.payload);
  payload.executionStatus = "PASS";
  await writeFile(fixture.indexPath, canonicalJsonFile(sealEvidenceIndex(payload)), "utf8");

  await assertValidationFailure(
    () => fixture.verifyIndex(),
    /evidence index must not duplicate ledger state/,
  );
});

test("rejects ledger file tampering through the index hash", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteLedger((payload) => {
    payload.entries[0].controlObjective = "A different but correctly resealed control objective.";
  });

  await assertValidationFailure(
    () => fixture.verifyIndex(),
    /index ledger ledger-20260718-01 SHA-256 mismatch/,
  );
});

test("rejects noncanonical JSON even when its semantic seal is valid", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const document = JSON.parse(await readFile(fixture.ledgerPath, "utf8"));
  await writeFile(fixture.ledgerPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  await assertValidationFailure(
    () => fixture.verifyLedger(),
    /ledger JSON is not canonical/,
  );
});

test("schemas enumerate every 7.1 field and keep index state-free", async () => {
  const ledgerSchema = JSON.parse(await readFile(path.join(repositoryRoot, "docs/evidence/ledger.schema.json"), "utf8"));
  const indexSchema = JSON.parse(await readFile(path.join(repositoryRoot, "docs/evidence/index.schema.json"), "utf8"));
  const entryRequired = new Set(ledgerSchema.$defs.entry.required);
  for (const field of [
    "gateId",
    "controlObjective",
    "environment",
    "prerequisites",
    "procedure",
    "expectedObservation",
    "threshold",
    "findingStatus",
    "executionStatus",
    "evidenceLevel",
    "executedAtUtc",
    "executor",
    "binding",
    "toolVersions",
    "evidence",
    "retryRecords",
    "relatedFindingsOrDecisions",
  ]) assert.equal(entryRequired.has(field), true, field);
  assert.deepEqual(ledgerSchema.$defs.executionStatus.enum, EXECUTION_STATUSES);
  assert.deepEqual(ledgerSchema.$defs.entry.properties.findingStatus.enum, DISCOVERY_STATUSES);
  assert.deepEqual(ledgerSchema.$defs.entry.properties.evidenceLevel.enum, EVIDENCE_LEVELS);
  assert.equal(Object.hasOwn(ledgerSchema.$defs.digests.properties.images, "minItems"), false);
  assert.deepEqual(Object.keys(indexSchema.properties.payload.properties).sort(), ["createdAtUtc", "indexId", "ledgerReferences"]);
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-evidence-ledger-test-"));
  const rawPath = path.join(root, "raw", "g0.txt");
  const manifestPath = path.join(root, "candidate-manifest.json");
  const ledgerPath = path.join(root, "ledger.json");
  const indexPath = path.join(root, "index.json");
  await mkdir(path.dirname(rawPath), { recursive: true });
  const raw = "gate=true\n";
  const rawSha256 = sha256Bytes(raw);
  await writeFile(rawPath, raw, "utf8");
  const manifestRaw = canonicalJsonFile({
    candidateId: expectedBinding.candidateId,
    deployId: expectedBinding.deployId,
    environmentId: expectedBinding.environmentId,
    sourceCommit: commitSha,
    signedTag: { name: "workbench-v1.0.0-rc.1" },
  });
  await writeFile(manifestPath, manifestRaw, "utf8");
  const payload = basePayload(sha256Bytes(manifestRaw));
  payload.entries = [baseEntry(rawSha256, "entry-001")];
  let ledger = sealEvidenceLedger(payload);
  let ledgerRaw = canonicalJsonFile(ledger);
  await writeFile(ledgerPath, ledgerRaw, "utf8");
  let index = sealEvidenceIndex({
    createdAtUtc: "2026-07-18T08:00:01Z",
    indexId: "index-20260718-01",
    ledgerReferences: [{
      ledgerId: payload.ledgerId,
      sha256: sha256Bytes(ledgerRaw),
      uri: "file:./ledger.json",
    }],
  });
  await writeFile(indexPath, canonicalJsonFile(index), "utf8");

  return {
    root,
    rawPath,
    rawSha256,
    manifestPath,
    ledgerPath,
    indexPath,
    ledger,
    index,
    cleanup: () => rm(root, { recursive: true, force: true }),
    async rewriteLedger(mutator, { reseal = true } = {}) {
      const current = JSON.parse(await readFile(ledgerPath, "utf8"));
      mutator(current.payload, current);
      ledger = reseal ? sealEvidenceLedger(current.payload) : current;
      ledgerRaw = canonicalJsonFile(ledger);
      await writeFile(ledgerPath, ledgerRaw, "utf8");
      this.ledger = ledger;
      return ledger;
    },
    verifyLedger() {
      return verifyEvidenceLedger({ ledgerPath, root, expectedBinding });
    },
    verifyIndex() {
      return verifyEvidenceIndex({ indexPath, root, expectedBinding });
    },
  };
}

function basePayload(candidateManifestSha256) {
  return {
    ledgerId: "ledger-20260718-01",
    createdAtUtc: "2026-07-18T08:00:00Z",
    binding: {
      ...baseBinding(),
      candidateManifest: {
        sha256: candidateManifestSha256,
        uri: "file:./candidate-manifest.json",
      },
    },
    previousLedger: null,
    entries: [],
  };
}

function baseBinding() {
  return {
    candidateId: expectedBinding.candidateId,
    deployId: expectedBinding.deployId,
    environmentId: expectedBinding.environmentId,
    commitSha,
    tag: "workbench-v1.0.0-rc.1",
    releaseChainId: `sha256:${"7".repeat(64)}`,
    digests: {
      images: [{ name: "web", digest: imageDigest }],
      configSha256,
      migrationSha256,
      deploymentConfigManifestSha256,
      imageManifestSha256: "5".repeat(64),
      controlCatalogSha256: "6".repeat(64),
    },
  };
}

function baseEntry(rawSha256, entryId) {
  return {
    entryId,
    gateId: "G0",
    controlObjective: "Prove the frozen release candidate is reproducible.",
    environment: {
      environmentId: expectedBinding.environmentId,
      kind: "production",
      description: "Dedicated production acceptance environment.",
      region: "cn-hangzhou",
    },
    prerequisites: ["Signed release candidate tag is available."],
    procedure: {
      kind: "command",
      command: "npm ci && npm run typecheck",
    },
    expectedObservation: "The command exits zero without modifying generated files.",
    threshold: {
      kind: "boolean",
      operator: "eq",
      expected: true,
    },
    findingStatus: "CONFIRMED",
    executionStatus: "PASS",
    evidenceLevel: "E2",
    executedAtUtc: "2026-07-18T07:59:59Z",
    executor: {
      id: "ci-release-01",
      kind: "ci",
    },
    binding: baseBinding(),
    toolVersions: [{ name: "node", version: "v22.22.0" }],
    evidence: [{ uri: "file:./raw/g0.txt", sha256: rawSha256 }],
    retryRecords: [],
    relatedFindingsOrDecisions: [{ kind: "decision", id: "R0" }],
  };
}

async function assertValidationFailure(action, pattern) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof EvidenceValidationError, true, error?.stack ?? String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

function reverseObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeyOrder(value[key])]));
}

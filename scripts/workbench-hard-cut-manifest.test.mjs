import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  canonicalJson,
  canonicalJsonFile,
  sealEvidenceLedger,
  sha256Bytes,
} from "./evidence-ledger.mjs";
import {
  validateHardCutManifest,
  verifyHardCutReceipt,
} from "./workbench-hard-cut-manifest.mjs";

const scopeId = "legacy-production-database";
const validationNow = new Date("2026-07-19T08:00:00Z");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the checked-in pre-cutover manifest is honest but cannot pass enforce", async () => {
  const report = await validateHardCutManifest({ now: validationNow });
  assert.equal(report.status, "pending");
  assert.deepEqual(report.findings, []);

  const enforced = await validateHardCutManifest({ enforce: true, now: validationNow });
  assert.equal(enforced.status, "invalid");
  assert(enforced.findings.includes("enforced hard cut requires candidateBinding"));
  assert(enforced.findings.includes("enforced hard cut requires cutoverReceipts.productionAcceptance"));
});

test("the production branch cannot bypass hard-cut enforce mode", async () => {
  const workflow = YAML.parse(await readFile(
    path.join(repoRoot, ".github/workflows/workbench-ci.yml"),
    "utf8",
  ));
  const gate = workflow.jobs["hard-cut-release-gate"];
  assert.equal(gate.if, "github.event_name == 'push' && github.ref == 'refs/heads/production'");
  assert.deepEqual(gate.needs, ["quality", "deployment-config", "production-images", "image-evidence"]);
  assert.equal(
    gate.steps.at(-1).run,
    "npm run hard-cut:manifest -- --enforce",
  );
});

test("verifies a candidate-bound, sealed, signed hard-cut receipt", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const report = await verifyFixture(fixture);
  assert.equal(report.ok, true, report.findings.join("\n"));
  assert.equal(report.verified.executorId, "hard-cut-automation");
});

test("rejects nonexistent evidence, digest mismatch, and signature tampering", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const missing = structuredClone(fixture.receipt);
  missing.ledger.uri = "file:./missing-ledger.json";
  assert.match((await verifyFixture(fixture, missing)).findings.join("\n"), /realpath|ENOENT|no such file/iu);

  const wrongHash = structuredClone(fixture.receipt);
  wrongHash.ledger.sha256 = "0".repeat(64);
  assert.match((await verifyFixture(fixture, wrongHash)).findings.join("\n"), /ledger SHA-256 mismatch/u);

  const forged = structuredClone(fixture.receipt);
  forged.signature.value = `${forged.signature.value[0] === "A" ? "B" : "A"}${forged.signature.value.slice(1)}`;
  assert.match((await verifyFixture(fixture, forged)).findings.join("\n"), /signature verification failed/u);
});

test("rejects candidate, environment, validity, and residual-threshold mismatches", async (t) => {
  const fixture = await createReceiptFixture();
  t.after(fixture.cleanup);

  const wrongCommit = {
    ...fixture.candidateBinding,
    commitSha: "9".repeat(40),
  };
  assert.match(
    (await verifyFixture(fixture, fixture.receipt, { candidateBinding: wrongCommit })).findings.join("\n"),
    /candidate binding mismatch|signature verification failed/u,
  );

  const wrongEnvironment = {
    ...fixture.candidateBinding,
    environmentId: "production-other",
  };
  assert.match(
    (await verifyFixture(fixture, fixture.receipt, { candidateBinding: wrongEnvironment })).findings.join("\n"),
    /environmentId mismatch|candidate binding mismatch/u,
  );

  const expired = await createReceiptFixture({
    signedAtUtc: "2026-07-17T08:00:00Z",
    validUntilUtc: "2026-07-18T08:00:00Z",
  });
  t.after(expired.cleanup);
  assert.match((await verifyFixture(expired)).findings.join("\n"), /signature has expired/u);

  const residual = await createReceiptFixture({ residualCount: 1 });
  t.after(residual.cleanup);
  assert.match((await verifyFixture(residual)).findings.join("\n"), /zero residual count/u);
});

async function verifyFixture(fixture, receipt = fixture.receipt, overrides = {}) {
  return verifyHardCutReceipt({
    receipt,
    expectedScopeId: scopeId,
    expectedThreshold: "zero",
    candidateBinding: fixture.candidateBinding,
    root: fixture.root,
    now: validationNow,
    ...overrides,
  });
}

async function createReceiptFixture({
  residualCount = 0,
  signedAtUtc = "2026-07-19T07:30:00Z",
  validUntilUtc = "2026-07-20T08:00:00Z",
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-hard-cut-receipt-"));
  const rawDirectory = path.join(root, "raw");
  await mkdir(rawDirectory);
  const rawPath = path.join(rawDirectory, "cleanup.json");
  const raw = Buffer.from(`${JSON.stringify({ residualCount })}\n`, "utf8");
  await writeFile(rawPath, raw);

  const candidateBinding = {
    candidateId: "rc-20260719-fixture",
    deployId: "deploy-20260719-fixture",
    environmentId: "production-cn-hangzhou",
    commitSha: "1".repeat(40),
    tag: "workbench-v1.0.0-fixture",
    digests: {
      images: [{ name: "web", digest: `sha256:${"4".repeat(64)}` }],
      configSha256: "2".repeat(64),
      migrationSha256: "3".repeat(64),
    },
  };
  const entry = {
    entryId: "entry-hard-cut-database",
    gateId: "G12",
    controlObjective: "Prove the legacy production database has no residual objects.",
    environment: {
      environmentId: candidateBinding.environmentId,
      kind: "production",
      description: "Isolated product workbench production environment.",
      region: "cn-hangzhou",
    },
    prerequisites: ["The frozen candidate is deployed and healthy."],
    procedure: { kind: "command", command: "server-hard-cut --scope legacy-production-database" },
    expectedObservation: "The residual object count is zero.",
    threshold: { kind: "number", operator: "eq", expected: residualCount, unit: "objects" },
    findingStatus: "CONFIRMED",
    executionStatus: "PASS",
    evidenceLevel: "E1",
    executedAtUtc: "2026-07-19T07:00:00Z",
    executor: { id: "hard-cut-automation", kind: "automation" },
    binding: candidateBinding,
    toolVersions: [{ name: "server-hard-cut", version: "1.0.0" }],
    evidence: [{ uri: "file:./raw/cleanup.json", sha256: sha256Bytes(raw) }],
    retryRecords: [],
    relatedFindingsOrDecisions: [{ kind: "decision", id: scopeId }],
  };
  const ledger = sealEvidenceLedger({
    ledgerId: "ledger-hard-cut-fixture",
    createdAtUtc: "2026-07-19T07:15:00Z",
    binding: candidateBinding,
    previousLedger: null,
    entries: [entry],
  });
  const ledgerRaw = Buffer.from(canonicalJsonFile(ledger), "utf8");
  const ledgerPath = path.join(root, "ledger.json");
  await writeFile(ledgerPath, ledgerRaw);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = Buffer.from(publicKey.export({ type: "spki", format: "pem" }));
  await writeFile(path.join(root, "auditor-public.pem"), publicKeyRaw);
  const unsignedReceipt = {
    schemaVersion: "workbench.hard-cut-receipt.v1",
    scopeId,
    ledger: {
      ledgerId: ledger.payload.ledgerId,
      entryId: entry.entryId,
      uri: "file:./ledger.json",
      sha256: sha256Bytes(ledgerRaw),
    },
    signedAtUtc,
    validUntilUtc,
  };
  const signature = sign(null, Buffer.from(canonicalJson({
    ...unsignedReceipt,
    candidateBinding,
  }), "utf8"), privateKey).toString("base64url");
  const receipt = {
    ...unsignedReceipt,
    signature: {
      algorithm: "Ed25519",
      publicKeyUri: "file:./auditor-public.pem",
      publicKeySha256: sha256Bytes(publicKeyRaw),
      value: signature,
    },
  };
  return {
    root,
    receipt,
    candidateBinding,
    ledgerPath,
    raw: JSON.parse((await readFile(rawPath, "utf8")).trim()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

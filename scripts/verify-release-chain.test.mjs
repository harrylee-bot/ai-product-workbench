import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  validateG1ManifestAndInventory,
  validateG2Receipt,
  validateInventoryBytes,
  verifyReleaseChain,
} from "./verify-release-chain.mjs";
import { canonicalJson, sealReceipt } from "./verify-workbench-reproducibility.mjs";

const commit = "a".repeat(40);
const tag = "workbench-2026.07.20";
const tree = "b".repeat(40);
const candidateId = `sha256:${"c".repeat(64)}`;

test("verifies G0, G1 inventory, and G2 as one candidate-bound chain", async () => {
  const fixture = createFixture();
  try {
    const result = await verifyReleaseChain({
      ...fixture.paths,
      expectedCommit: commit,
      expectedSignedTag: tag,
      expectedHashes: fixture.hashes,
      verifyG0: async ({ expectedCandidate }) => ({
        gatePassed: true,
        candidateManifestVerified: true,
        candidateId: expectedCandidate.candidateId,
        sourceCommit: expectedCandidate.sourceCommit,
        signedTag: expectedCandidate.signedTag,
        recordId: "g0-production-approval",
        environmentId: "production",
      }),
    });
    assert.equal(result.status, "PASS");
    assert.match(result.chainId, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.candidateId, candidateId);
    assert.equal(result.sourceCommit, commit);
    assert.equal(result.signedTag, tag);
    assert.equal(result.g1.inventoryEntryCount, 1);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an inventory whose downloaded bytes do not match the expected hash", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      verifyReleaseChain({
        ...fixture.paths,
        expectedCommit: commit,
        expectedSignedTag: tag,
        expectedHashes: { ...fixture.hashes, g1Inventory: "d".repeat(64) },
        verifyG0: () => {
          throw new Error("G0 must not run after artifact hash failure");
        },
      }),
      /G1 inventory SHA-256 mismatch/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects noncanonical Git object lengths before reading release artifacts", async () => {
  await assert.rejects(
    verifyReleaseChain({ expectedCommit: "a".repeat(41) }),
    /expected source commit is invalid/u,
  );
});

test("accepts only the G1 v2 pre-image DeerFlow binding", () => {
  const fixture = createFixture();
  try {
    const validate = (manifest) => validateG1ManifestAndInventory({
      manifest,
      inventoryRaw: fixture.inventoryRaw,
      inventorySha256: fixture.hashes.g1Inventory,
      expectedCommit: commit,
      expectedSignedTag: tag,
    });
    assert.doesNotThrow(() => validate(fixture.manifest));

    const legacy = structuredClone(fixture.manifest);
    legacy.schemaVersion = 1;
    assert.throws(() => validate(legacy), /schemaVersion must be 2/u);

    const derivedImage = structuredClone(fixture.manifest);
    delete derivedImage.releaseMetadata.deerFlow.baseImageDigest;
    derivedImage.releaseMetadata.deerFlow.imageDigest = `sha256:${"4".repeat(64)}`;
    assert.throws(() => validate(derivedImage), /baseImageDigest is invalid/u);
  } finally {
    fixture.cleanup();
  }
});

test("changes the release-chain ID when the approved G0 artifact changes", async () => {
  const fixture = createFixture();
  const verifyG0 = async ({ expectedCandidate }) => ({
    gatePassed: true,
    candidateManifestVerified: true,
    candidateId: expectedCandidate.candidateId,
    sourceCommit: expectedCandidate.sourceCommit,
    signedTag: expectedCandidate.signedTag,
    recordId: "g0-production-approval",
    environmentId: "production",
  });
  try {
    const first = await verifyReleaseChain({
      ...fixture.paths,
      expectedCommit: commit,
      expectedSignedTag: tag,
      expectedHashes: fixture.hashes,
      verifyG0,
    });
    const changedG0 = Buffer.from('{"executionStatus":"PASS","revision":2}\n', "utf8");
    writeFileSync(fixture.paths.g0ApprovalPath, changedG0);
    const second = await verifyReleaseChain({
      ...fixture.paths,
      expectedCommit: commit,
      expectedSignedTag: tag,
      expectedHashes: { ...fixture.hashes, g0Approval: sha256(changedG0) },
      verifyG0,
    });
    assert.notEqual(first.chainId, second.chainId);
    assert.notEqual(first.g0.approvalSha256, second.g0.approvalSha256);
  } finally {
    fixture.cleanup();
  }
});

test("rejects G2 receipts with skipped checks or incomplete cleanup", () => {
  const fixture = createFixture();
  try {
    const receipt = JSON.parse(fixture.g2Raw.toString("utf8"));
    receipt.payload.skippedChecks = ["typecheck"];
    assert.throws(
      () => validateG2Receipt({
        receipt: sealReceipt(receipt.payload),
        expectedCommit: commit,
        expectedSignedTag: tag,
        expectedSourceTree: tree,
      }),
      /must not skip checks/u,
    );

    const cleanReceipt = JSON.parse(fixture.g2Raw.toString("utf8"));
    cleanReceipt.payload.isolation.cleanupStatus = "FAIL";
    assert.throws(
      () => validateG2Receipt({
        receipt: sealReceipt(cleanReceipt.payload),
        expectedCommit: commit,
        expectedSignedTag: tag,
        expectedSourceTree: tree,
      }),
      /cleanup must PASS/u,
    );

    const mismatchedAudit = JSON.parse(fixture.g2Raw.toString("utf8"));
    mismatchedAudit.payload.generationRounds[0].sourceAuditSha256 = "2".repeat(64);
    assert.throws(
      () => validateG2Receipt({
        receipt: sealReceipt(mismatchedAudit.payload),
        expectedCommit: commit,
        expectedSignedTag: tag,
        expectedSourceTree: tree,
      }),
      /source audit hash does not match/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects non-canonical inventory lines", () => {
  const raw = Buffer.from('{"b":2,"a":1}\n', "utf8");
  assert.throws(
    () => validateInventoryBytes({
      raw,
      expectedSha256: sha256(raw),
      expectedManifestInventory: {
        sha256: sha256(raw),
        byteSize: raw.length,
        entryCount: 1,
      },
    }),
    /not canonical JSON/u,
  );
});

test("rejects inventory summaries and source-tree digests that do not match the entries", () => {
  const fixture = createFixture();
  try {
    const wrongSummary = structuredClone(fixture.manifest.inventory);
    wrongSummary.byDisposition.included.entryCount = 0;
    assert.throws(
      () => validateInventoryBytes({
        raw: fixture.inventoryRaw,
        expectedSha256: fixture.hashes.g1Inventory,
        expectedManifestInventory: wrongSummary,
        expectedSourceTree: fixture.manifest.sourceTree,
      }),
      /disposition\.included entryCount mismatch/u,
    );
    assert.throws(
      () => validateInventoryBytes({
        raw: fixture.inventoryRaw,
        expectedSha256: fixture.hashes.g1Inventory,
        expectedManifestInventory: fixture.manifest.inventory,
        expectedSourceTree: { ...fixture.manifest.sourceTree, sha256: "0".repeat(64) },
      }),
      /sourceTree SHA-256 does not match/u,
    );
  } finally {
    fixture.cleanup();
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "workbench-release-chain-"));
  const inventoryEntries = [{
    path: "README.md",
    repositoryState: "tracked",
    disposition: "included",
    reasonCode: "trackedCandidateFile",
    fileType: "file",
    byteSize: 128,
    sha256: "7".repeat(64),
    gitMode: "100644",
    gitBlobId: "8".repeat(40),
  }];
  const inventoryRaw = Buffer.from(`${inventoryEntries.map((entry) => canonicalJson(entry)).join("\n")}\n`, "utf8");
  const manifest = {
    schemaVersion: 2,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    candidateId,
    sourceCommit: commit,
    sourceTree: {
      gitTree: tree,
      sha256: sha256(canonicalJson(inventoryEntries.map(compactInventoryEntry))),
      entryCount: 1,
    },
    signedTag: {
      name: tag,
      tagObject: "e".repeat(40),
      targetCommit: commit,
      payloadSha256: "f".repeat(64),
      verified: true,
    },
    status: { clean: true, porcelainV1: "" },
    captureConsistency: {
      sourceCommitStable: true,
      gitTreeStable: true,
      branchStable: true,
      statusStable: true,
    },
    releaseMetadata: {
      deerFlow: {
        sourceCommit: "d".repeat(40),
        baseImageDigest: `sha256:${"2".repeat(64)}`,
        overlayConfigSha256: "3".repeat(64),
      },
    },
    gate: { gateId: "G1", status: "PASS", findingCount: 0 },
    findings: [],
    inventory: {
      sha256: sha256(inventoryRaw),
      byteSize: inventoryRaw.length,
      entryCount: 1,
      byRepositoryState: summarizeInventory(inventoryEntries, "repositoryState", ["tracked", "untracked", "ignored"]),
      byDisposition: summarizeInventory(inventoryEntries, "disposition", ["included", "blocked", "excluded", "external"]),
    },
  };
  const sourceAudits = ["post-install", "generation-round-1", "generation-round-2", "post-checks"]
    .map((phase) => ({ phase, status: "PASS" }));
  const g2Raw = Buffer.from(`${JSON.stringify(sealReceipt({
    product: "产品工作台",
    technicalIdentifier: "workbench",
    gateId: "G2",
    status: "PASS",
    binding: {
      sourceCommit: commit,
      sourceTree: tree,
      cloneCommit: commit,
      cloneTree: tree,
      tag: {
        name: tag,
        objectId: "e".repeat(40),
        payloadSha256: "f".repeat(64),
        peeledCommit: commit,
        verified: true,
      },
    },
    generationRounds: [1, 2].map((round) => ({
      round,
      status: "PASS",
      sourceAuditSha256: sha256(canonicalJson(sourceAudits[round])),
    })),
    checks: ["openapi", "runtimeSchema", "runtimeValidator", "typecheck"].map((id) => ({ id, status: "PASS" })),
    skippedChecks: [],
    sourceAudits,
    isolation: { initialClean: true, cleanupStatus: "PASS" },
    commands: [{ id: "check.typecheck", status: "PASS" }],
    failure: null,
  }))}\n`, "utf8");
  const g0Raw = Buffer.from("{\"executionStatus\":\"PASS\"}\n", "utf8");
  const paths = {
    g0ApprovalPath: join(root, "g0.json"),
    g1ManifestPath: join(root, "g1.json"),
    g1InventoryPath: join(root, "inventory.ndjson"),
    g2ReceiptPath: join(root, "g2.json"),
  };
  writeFileSync(paths.g0ApprovalPath, g0Raw);
  writeFileSync(paths.g1ManifestPath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(paths.g1InventoryPath, inventoryRaw);
  writeFileSync(paths.g2ReceiptPath, g2Raw);
  return {
    paths,
    manifest,
    inventoryRaw,
    g2Raw,
    hashes: {
      g0Approval: sha256(g0Raw),
      g1Manifest: sha256(Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")),
      g1Inventory: sha256(inventoryRaw),
      g2Receipt: sha256(g2Raw),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function summarizeInventory(entries, field, values) {
  return Object.fromEntries(values.map((value) => {
    const selected = entries.filter((entry) => entry[field] === value);
    const ndjson = selected.length === 0 ? "" : `${selected.map((entry) => canonicalJson(entry)).join("\n")}\n`;
    return [value, { entryCount: selected.length, sha256: sha256(ndjson) }];
  }));
}

function compactInventoryEntry(entry) {
  return {
    path: entry.path,
    fileType: entry.fileType,
    byteSize: entry.byteSize,
    sha256: entry.sha256,
    gitMode: entry.gitMode,
    gitBlobId: entry.gitBlobId,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

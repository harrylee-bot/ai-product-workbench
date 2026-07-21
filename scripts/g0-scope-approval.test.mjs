import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  G0ApprovalValidationError,
  G0_FINDING_IDS,
  G0_GATE_IDS,
  G0_ROLES,
  sha256Bytes,
  verifyG0ScopeApproval,
} from "./g0-scope-approval.mjs";
import {
  canonicalJson,
  REQUIRED_SOURCE_SCOPES,
} from "./release-candidate-manifest-lib.mjs";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-07-19T12:00:00Z");
const SOURCE_COMMIT = "b".repeat(40);
const SOURCE_TREE_SHA256 = "e".repeat(64);
const SIGNED_TAG = "workbench-v1.0.0-rc.1";
const TAG_OBJECT = "c".repeat(40);
const TAG_PAYLOAD_SHA256 = "d".repeat(64);
const CANDIDATE = Object.freeze({
  candidateId: `sha256:${sha256Bytes(canonicalJson({
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE_SHA256,
    signedTag: {
      name: SIGNED_TAG,
      tagObject: TAG_OBJECT,
      payloadSha256: TAG_PAYLOAD_SHA256,
    },
  }))}`,
  sourceCommit: SOURCE_COMMIT,
  signedTag: SIGNED_TAG,
  tagObject: TAG_OBJECT,
  payloadSha256: TAG_PAYLOAD_SHA256,
});

test("validates a complete PASS record bound to a candidate manifest and hashed approvals", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const report = await fixture.verify();

  assert.equal(report.ok, true);
  assert.equal(report.gatePassed, true);
  assert.equal(report.executionStatus, "PASS");
  assert.equal(report.product, "产品工作台");
  assert.equal(report.candidateManifestVerified, true);
  assert.equal(report.capabilityCount, 3);
  assert.equal(report.waiverCount, 0);
  assert.ok(report.localApprovalReferenceCount >= 7);
});

test("keeps the repository example explicitly NOT RUN and never reports gate PASS", async () => {
  const examplePath = new URL("../docs/evidence/governance/g0-scope-approval.example.json", import.meta.url);
  const example = JSON.parse(await readFile(examplePath, "utf8"));
  const report = await verifyG0ScopeApproval({
    approvalPath: filePath(examplePath),
    root: path.dirname(filePath(examplePath)),
    expectedCandidate: {
      candidateId: example.candidate.candidateId,
      sourceCommit: example.candidate.sourceCommit,
      signedTag: example.candidate.signedTag.name,
    },
    now: NOW,
  });

  assert.equal(report.executionStatus, "NOT RUN");
  assert.equal(report.gatePassed, false);
  assert.equal(report.candidateManifestVerified, false);
});

test("requires every current remediation finding through D-039", async (t) => {
  assert.deepEqual(
    G0_FINDING_IDS.filter((id) => id.startsWith("D-")).slice(-6),
    ["D-034", "D-035", "D-036", "D-037", "D-038", "D-039"],
  );
  assert.equal(G0_FINDING_IDS.length, 58);

  const legacy = await createFixture();
  t.after(legacy.cleanup);
  await legacy.rewrite((document) => {
    document.scope.findingIds = document.scope.findingIds.filter((id) => ![
      "D-034",
      "D-035",
      "D-036",
      "D-037",
      "D-038",
      "D-039",
    ].includes(id));
    document.responsibilityMatrix.schedule[1].scopeItemIds =
      document.responsibilityMatrix.schedule[1].scopeItemIds.filter((id) => document.scope.findingIds.includes(id));
  });

  await expectFailure(() => legacy.verify(), /must contain (?:at least|exactly) 58/);
});

test("CLI returns exit code 2 for a valid NOT RUN example", async () => {
  const scriptPath = filePath(new URL("./g0-scope-approval.mjs", import.meta.url));
  const examplePath = filePath(new URL("../docs/evidence/governance/g0-scope-approval.example.json", import.meta.url));
  const example = JSON.parse(await readFile(examplePath, "utf8"));
  await assert.rejects(
    execFileAsync(process.execPath, [
      scriptPath,
      "--root", path.dirname(examplePath),
      "--approval", examplePath,
      "--candidate-id", example.candidate.candidateId,
      "--source-commit", example.candidate.sourceCommit,
      "--signed-tag", example.candidate.signedTag.name,
      "--now", NOW.toISOString(),
    ]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stdout, /"gatePassed":false/);
      assert.match(error.stdout, /"executionStatus":"NOT RUN"/);
      return true;
    },
  );
});

test("rejects TBD and missing responsibility owners", async (t) => {
  const tbd = await createFixture();
  t.after(tbd.cleanup);
  await tbd.rewrite((document) => {
    document.responsibilityMatrix.owners[0].owner.displayName = "TBD";
  });
  await expectFailure(() => tbd.verify(), /contains a TBD\/placeholder value/);

  const missing = await createFixture();
  t.after(missing.cleanup);
  await missing.rewrite((document) => {
    document.responsibilityMatrix.owners = document.responsibilityMatrix.owners.filter(({ role }) => role !== "Evidence");
  });
  await expectFailure(() => missing.verify(), /owners is missing Evidence/);
});

test("rejects Implementer self-approval through Security, Data, Operations, or Release", async (t) => {
  for (const role of ["Security", "Data", "Operations", "Release"]) {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    await fixture.rewrite((document) => {
      const implementerId = ownerFor(document, "Implementer").owner.id;
      const target = ownerFor(document, role);
      target.owner.id = implementerId;
      target.approval.approverId = implementerId;
      for (const capability of document.capabilities) {
        for (const approval of capability.approvals) {
          if (approval.approverRole === role) approval.approverId = implementerId;
        }
      }
    });
    await expectFailure(() => fixture.verify(), new RegExp(`${role} owner must be independent from Implementer`));
  }
});

test("rejects expired N/A capability classifications and missing N/A approval", async (t) => {
  const expired = await createFixture();
  t.after(expired.cleanup);
  await expired.rewrite((document) => {
    capabilityFor(document, "N/A").classificationExpiresAtUtc = "2026-07-19T11:59:59Z";
  });
  await expectFailure(() => expired.verify(), /classificationExpiresAtUtc is expired/);

  const missing = await createFixture();
  t.after(missing.cleanup);
  await missing.rewrite((document) => {
    capabilityFor(document, "N/A").approvals = [];
  });
  await expectFailure(() => missing.verify(), /requires Security approval for PASS/);
  await expectFailure(() => missing.verify(), /requires Release approval for PASS/);
});

test("rejects mutable approval URIs", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewrite((document) => {
    ownerFor(document, "Security").approval.reference = {
      uri: "https://evidence.example.test/latest/security-approval.json",
      sha256: "e".repeat(64),
    };
  });

  await expectFailure(() => fixture.verify(), /uri is mutable or unsupported/);
});

test("rejects credential and presigned query parameters even when a remote URI is version-pinned", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const forbiddenParameters = [
    "access_token",
    "api-key",
    "Authorization",
    "key",
    "signature",
    "sig",
    "token",
    "X-Amz-Credential",
    "X-Amz-Security-Token",
    "X-Amz-Signature",
    "X-Goog-Credential",
    "X-Goog-Signature",
  ];

  for (const parameter of forbiddenParameters) {
    await fixture.rewrite((document) => {
      ownerFor(document, "Evidence").approval.reference = {
        uri: `https://evidence.example.test/object?versionId=immutable-v1&${parameter}=redacted-credential-value`,
        sha256: "e".repeat(64),
      };
    });
    await expectFailure(
      () => fixture.verify(),
      /uri is mutable or unsupported/,
    );
  }
});

test("rejects wrong local evidence hashes", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewrite((document) => {
    ownerFor(document, "Data").approval.reference.sha256 = "f".repeat(64);
  });

  await expectFailure(() => fixture.verify(), /SHA-256 mismatch/);
});

test("rejects candidate binding that differs from the externally expected identity", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  await expectFailure(
    () => fixture.verify({ expectedCandidate: { ...fixture.expectedCandidate, candidateId: `sha256:${"9".repeat(64)}` } }),
    /does not match externally expected candidateId/,
  );
  await expectFailure(
    () => fixture.verify({ expectedCandidate: { ...fixture.expectedCandidate, signedTag: "workbench-v1.0.0-wrong" } }),
    /does not match externally expected signedTag/,
  );
});

test("rejects wrong product and incomplete or non-production PASS environment", async (t) => {
  const wrongProduct = await createFixture();
  t.after(wrongProduct.cleanup);
  await wrongProduct.rewrite((document) => {
    document.product = "Stitch";
  });
  await expectFailure(() => wrongProduct.verify(), /product must equal "产品工作台"/);

  const missingRegion = await createFixture();
  t.after(missingRegion.cleanup);
  await missingRegion.rewrite((document) => {
    delete document.environment.region;
  });
  await expectFailure(() => missingRegion.verify(), /environment.region is required/);

  const staging = await createFixture();
  t.after(staging.cleanup);
  await staging.rewrite((document) => {
    document.environment.kind = "staging";
  });
  await expectFailure(() => staging.verify(), /kind must be production when G0 executionStatus is PASS/);
});

test("accepts a content-addressed immutable approval URI with an explicit SHA-256", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewrite((document) => {
    const approval = ownerFor(document, "Evidence").approval;
    approval.reference.uri = `urn:sha256:${approval.reference.sha256}`;
  });

  const report = await fixture.verify();
  assert.equal(report.gatePassed, true);
});

test("rejects candidate manifest hash and identity drift", async (t) => {
  const wrongHash = await createFixture();
  t.after(wrongHash.cleanup);
  await wrongHash.rewrite((document) => {
    document.candidate.manifest.sha256 = "1".repeat(64);
  });
  await expectFailure(() => wrongHash.verify(), /candidate manifest SHA-256 mismatch/);

  const wrongIdentity = await createFixture();
  t.after(wrongIdentity.cleanup);
  await wrongIdentity.rewriteManifest((manifest) => {
    manifest.candidateId = `sha256:${"2".repeat(64)}`;
  }, { updateReferenceHash: true });
  await expectFailure(() => wrongIdentity.verify(), /candidate manifest candidateId mismatch/);
});

test("rejects a supplied candidate manifest that does not satisfy the complete v2 schema", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteManifest((manifest) => {
    delete manifest.technicalIdentifier;
  }, { updateReferenceHash: true });

  await expectFailure(
    () => fixture.verify(),
    /candidate manifest schema .*technicalIdentifier/,
  );

  const legacy = await createFixture();
  t.after(legacy.cleanup);
  await legacy.rewriteManifest((manifest) => {
    manifest.schemaVersion = 1;
  }, { updateReferenceHash: true });
  await expectFailure(
    () => legacy.verify(),
    /candidate manifest schema .*schemaVersion/,
  );
});

test("rejects a G1 FAIL candidate manifest even when the G0 approval record claims PASS", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await fixture.rewriteManifest((manifest) => {
    manifest.gate.status = "FAIL";
    manifest.gate.findingCount = 1;
    manifest.findings = [{
      code: "DIRTY_WORKTREE",
      path: null,
      detail: "fixture G1 failure",
    }];
  }, { updateReferenceHash: true });

  await expectFailure(() => fixture.verify(), /candidate manifest G1 gate.status must be PASS/);
  await expectFailure(() => fixture.verify(), /candidate manifest G1 must contain zero findings/);
});

test("rejects candidate manifests with non-releaseable semantic state", async (t) => {
  const cases = [
    {
      expected: /must record a clean Git worktree/,
      mutate(manifest) {
        manifest.status.clean = false;
        manifest.status.porcelainV1 = " M apps/web/app/page.tsx\n";
        manifest.status.sha256 = sha256Bytes(manifest.status.porcelainV1);
      },
    },
    {
      expected: /captureConsistency.statusStable must be true/,
      mutate(manifest) {
        manifest.captureConsistency.statusStable = false;
      },
    },
    {
      expected: /criticalArtifacts.migrations must be complete/,
      mutate(manifest) {
        manifest.criticalArtifacts.migrations.status = "blocked";
        manifest.criticalArtifacts.migrations.blockedEntryCount = 1;
      },
    },
    {
      expected: /source scope web must be complete/,
      mutate(manifest) {
        const scope = manifest.sourceScopes.find(({ name }) => name === "web");
        scope.status = "blocked";
        scope.blockedEntryCount = 1;
      },
    },
    {
      expected: /knowledgeStorage.auditPassed must be true/,
      mutate(manifest) {
        manifest.knowledgeStorage.auditPassed = false;
      },
    },
  ];

  for (const scenario of cases) {
    const fixture = await createFixture();
    t.after(fixture.cleanup);
    await fixture.rewriteManifest(scenario.mutate, { updateReferenceHash: true });
    await expectFailure(() => fixture.verify(), scenario.expected);
  }
});

test("rejects PASS without an independently supplied candidate manifest", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  await expectFailure(
    () => fixture.verify({ candidateManifestPath: undefined }),
    /PASS requires candidateManifestPath/,
  );
});

test("rejects secrets in the G0 record and referenced approval evidence", async (t) => {
  const inRecord = await createFixture();
  t.after(inRecord.cleanup);
  await inRecord.rewrite((document) => {
    document.environment.target = "https://operator:reusable-password@example.test";
  });
  await expectFailure(() => inRecord.verify(), /contains possible URL credential/);

  const inEvidence = await createFixture();
  t.after(inEvidence.cleanup);
  const securityEvidencePath = path.join(inEvidence.root, "approvals", "security.txt");
  const secretBytes = "authorization=ReusableCredentialValue123\n";
  await writeFile(securityEvidencePath, secretBytes, "utf8");
  await inEvidence.rewrite((document) => {
    for (const approval of allApprovals(document)) {
      if (approval.reference.uri === "file:./approvals/security.txt") {
        approval.reference.sha256 = sha256Bytes(secretBytes);
      }
    }
  });
  await expectFailure(() => inEvidence.verify(), /contains possible assigned credential/);
});

test("rejects incomplete schedules and overdue PASS targets", async (t) => {
  const incomplete = await createFixture();
  t.after(incomplete.cleanup);
  await incomplete.rewrite((document) => {
    document.responsibilityMatrix.schedule[1].scopeItemIds = document.responsibilityMatrix.schedule[1].scopeItemIds.slice(1);
  });
  await expectFailure(() => incomplete.verify(), /does not assign target\/escalation\/overdue handling for D-001/);

  const overdue = await createFixture();
  t.after(overdue.cleanup);
  await overdue.rewrite((document) => {
    document.responsibilityMatrix.schedule[0].targetDateUtc = "2026-07-19T11:00:00Z";
  });
  await expectFailure(() => overdue.verify(), /targetDateUtc is overdue/);
});

test("rejects forbidden, expired, and incompletely approved waivers", async (t) => {
  const forbidden = await createFixture();
  t.after(forbidden.cleanup);
  await forbidden.rewrite((document) => {
    document.waivers.push(makeWaiver(document, "source-provenance"));
  });
  await expectFailure(() => forbidden.verify(), /source-provenance cannot be waived/);

  const expired = await createFixture();
  t.after(expired.cleanup);
  await expired.rewrite((document) => {
    const waiver = makeWaiver(document, "documentation");
    waiver.expiresAtUtc = "2026-07-19T11:59:59Z";
    document.waivers.push(waiver);
  });
  await expectFailure(() => expired.verify(), /expiresAtUtc is expired/);

  const incomplete = await createFixture();
  t.after(incomplete.cleanup);
  await incomplete.rewrite((document) => {
    const waiver = makeWaiver(document, "documentation");
    waiver.approvals = waiver.approvals.filter(({ approverRole }) => approverRole !== "Data");
    document.waivers.push(waiver);
  });
  await expectFailure(() => incomplete.verify(), /requires Data approval/);
});

test("rejects future and non-UTC signatures", async (t) => {
  const future = await createFixture();
  t.after(future.cleanup);
  await future.rewrite((document) => {
    ownerFor(document, "Release").approval.signedAtUtc = "2026-07-19T12:01:00Z";
  });
  await expectFailure(() => future.verify(), /signedAtUtc must not be in the future/);

  const nonUtc = await createFixture();
  t.after(nonUtc.cleanup);
  await nonUtc.rewrite((document) => {
    ownerFor(document, "Release").approval.signedAtUtc = "2026-07-19T09:00:00+08:00";
  });
  await expectFailure(() => nonUtc.verify(), /must be an ISO-8601 UTC timestamp ending in Z/);
});

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "g0-scope-approval-"));
  await mkdir(path.join(root, "approvals"), { recursive: true });
  const ownerIds = new Map([
    ["Implementer", "implementer@workbench.test"],
    ["Security", "security@workbench.test"],
    ["Data", "data@workbench.test"],
    ["Operations", "operations@workbench.test"],
    ["Evidence", "evidence@workbench.test"],
    ["Release", "release@workbench.test"],
  ]);
  const evidenceByRole = new Map();
  for (const role of G0_ROLES) {
    const relativePath = `approvals/${role.toLowerCase()}.txt`;
    const raw = `Detached G0 approval evidence for ${role}.\n`;
    await writeFile(path.join(root, ...relativePath.split("/")), raw, "utf8");
    evidenceByRole.set(role, { uri: `file:./${relativePath}`, sha256: sha256Bytes(raw) });
  }
  const candidateManifestPath = path.join(root, "candidate-manifest.json");
  const manifest = candidateManifest();
  const manifestRaw = jsonFile(manifest);
  await writeFile(candidateManifestPath, manifestRaw, "utf8");

  let approvalSequence = 0;
  const approvalFor = (role, prefix) => ({
    approvalId: `${prefix}-${role.toLowerCase()}-${++approvalSequence}`,
    approverRole: role,
    approverId: ownerIds.get(role),
    decision: "APPROVE",
    signedAtUtc: "2026-07-19T01:00:00Z",
    reference: structuredClone(evidenceByRole.get(role)),
  });
  const document = {
    schemaVersion: "workbench.g0-scope-approval.v1",
    recordId: "g0-approval-fixture",
    product: "产品工作台",
    gateId: "G0",
    executionStatus: "PASS",
    recordedAtUtc: "2026-07-19T02:00:00Z",
    candidate: {
      candidateId: CANDIDATE.candidateId,
      sourceCommit: CANDIDATE.sourceCommit,
      signedTag: {
        name: CANDIDATE.signedTag,
        tagObject: CANDIDATE.tagObject,
        payloadSha256: CANDIDATE.payloadSha256,
      },
      manifest: {
        uri: "file:./candidate-manifest.json",
        sha256: sha256Bytes(manifestRaw),
      },
    },
    environment: {
      environmentId: "production-cn-hz-01",
      kind: "production",
      target: "workbench-production-cluster",
      region: "cn-hangzhou",
    },
    scope: {
      gateIds: [...G0_GATE_IDS],
      findingIds: [...G0_FINDING_IDS],
    },
    capabilities: [
      capability({
        id: "core-workbench",
        classification: "advertised",
        role: "Operations",
        approvals: [approvalFor("Operations", "cap-core"), approvalFor("Release", "cap-core")],
      }),
      capability({
        id: "enterprise-sso",
        classification: "deferred",
        role: "Security",
        approvals: [approvalFor("Security", "cap-sso"), approvalFor("Release", "cap-sso")],
      }),
      capability({
        id: "figma-desktop",
        classification: "N/A",
        role: "Security",
        approvals: [approvalFor("Security", "cap-figma"), approvalFor("Release", "cap-figma")],
      }),
    ],
    responsibilityMatrix: {
      owners: G0_ROLES.map((role) => ({
        role,
        owner: {
          id: ownerIds.get(role),
          displayName: `${role} Owner`,
          team: `${role} Team`,
        },
        responsibilities: [`${role} responsibilities for every scoped gate and finding`],
        approval: approvalFor(role, "matrix"),
      })),
      schedule: [
        schedule([...G0_GATE_IDS]),
        schedule(G0_FINDING_IDS.filter((id) => id.startsWith("D-"))),
        schedule(G0_FINDING_IDS.filter((id) => id.startsWith("P-"))),
      ],
    },
    waivers: [],
  };
  const approvalPath = path.join(root, "g0-scope-approval.json");
  await writeFile(approvalPath, jsonFile(document), "utf8");

  return {
    root,
    approvalPath,
    candidateManifestPath,
    expectedCandidate: {
      candidateId: CANDIDATE.candidateId,
      sourceCommit: CANDIDATE.sourceCommit,
      signedTag: CANDIDATE.signedTag,
    },
    verify: (options = {}) => verifyG0ScopeApproval({
      approvalPath,
      root,
      expectedCandidate: options.expectedCandidate ?? {
        candidateId: CANDIDATE.candidateId,
        sourceCommit: CANDIDATE.sourceCommit,
        signedTag: CANDIDATE.signedTag,
      },
      candidateManifestPath: Object.hasOwn(options, "candidateManifestPath")
        ? options.candidateManifestPath
        : candidateManifestPath,
      now: NOW,
    }),
    rewrite: async (mutator) => {
      const current = JSON.parse(await readFile(approvalPath, "utf8"));
      mutator(current);
      await writeFile(approvalPath, jsonFile(current), "utf8");
    },
    rewriteManifest: async (mutator, { updateReferenceHash = false } = {}) => {
      const current = JSON.parse(await readFile(candidateManifestPath, "utf8"));
      mutator(current);
      const raw = jsonFile(current);
      await writeFile(candidateManifestPath, raw, "utf8");
      if (updateReferenceHash) {
        const approval = JSON.parse(await readFile(approvalPath, "utf8"));
        approval.candidate.manifest.sha256 = sha256Bytes(raw);
        await writeFile(approvalPath, jsonFile(approval), "utf8");
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function candidateManifest() {
  const inventoryEntryCount = REQUIRED_SOURCE_SCOPES.length;
  const inventorySlice = (entryCount, shaCharacter) => ({
    entryCount,
    sha256: shaCharacter.repeat(64),
  });
  const criticalArtifact = () => ({
    entryCount: 1,
    blockedEntryCount: 0,
    sha256: "9".repeat(64),
    status: "complete",
  });
  return {
    schemaVersion: 2,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    candidateId: CANDIDATE.candidateId,
    sourceCommit: CANDIDATE.sourceCommit,
    sourceTree: {
      gitTree: "f".repeat(40),
      sha256: SOURCE_TREE_SHA256,
      entryCount: inventoryEntryCount,
    },
    branch: "codex/workbench-greenfield",
    environmentId: "production-cn-hz-01",
    signedTag: {
      name: CANDIDATE.signedTag,
      tagObject: CANDIDATE.tagObject,
      targetCommit: CANDIDATE.sourceCommit,
      payloadSha256: CANDIDATE.payloadSha256,
      verified: true,
    },
    sourceCommitSignature: { verified: false },
    status: {
      command: "git status --porcelain=v1 --untracked-files=all",
      clean: true,
      porcelainV1: "",
      sha256: sha256Bytes(""),
    },
    deployId: "deploy-fixture-001",
    configRevision: "config-fixture-001",
    audit: {
      startedAt: "2026-07-19T00:00:00Z",
      endedAt: "2026-07-19T00:30:00Z",
      executor: "release-automation@workbench.test",
      verifier: "evidence-custodian@workbench.test",
    },
    releaseMetadata: {
      postgresVersion: "16.4",
      pgvectorVersion: "0.8.0",
      deerFlow: {
        sourceCommit: "1".repeat(40),
        baseImageDigest: `sha256:${"2".repeat(64)}`,
        overlayConfigSha256: "3".repeat(64),
      },
      images: {
        web: `sha256:${"4".repeat(64)}`,
      },
      artifacts: {},
    },
    inventory: {
      artifactName: "release-candidate-inventory.ndjson",
      mediaType: "application/x-ndjson",
      canonicalization: "fixture canonical NDJSON",
      sha256: "5".repeat(64),
      byteSize: 1024,
      entryCount: inventoryEntryCount,
      byRepositoryState: {
        tracked: inventorySlice(inventoryEntryCount, "6"),
        untracked: inventorySlice(0, "7"),
        ignored: inventorySlice(0, "7"),
      },
      byDisposition: {
        included: inventorySlice(inventoryEntryCount, "6"),
        blocked: inventorySlice(0, "7"),
        excluded: inventorySlice(0, "7"),
        external: inventorySlice(0, "7"),
      },
    },
    sourceScopes: REQUIRED_SOURCE_SCOPES.map((scope) => ({
      name: scope.name,
      roots: [...scope.roots],
      exactPaths: [...(scope.exactPaths ?? [])],
      entryCount: 1,
      blockedEntryCount: 0,
      sha256: "8".repeat(64),
      status: "complete",
    })),
    criticalArtifacts: {
      lockfile: criticalArtifact(),
      generatedContracts: criticalArtifact(),
      databaseSchema: criticalArtifact(),
      migrations: criticalArtifact(),
      ci: criticalArtifact(),
      deployment: criticalArtifact(),
      hardCutDeletion: criticalArtifact(),
      brandAssets: criticalArtifact(),
      knowledgeVaultMarkdown: criticalArtifact(),
      knowledgeVaultConfiguration: criticalArtifact(),
      remediationControl: criticalArtifact(),
      evidenceContracts: criticalArtifact(),
    },
    knowledgeStorage: {
      policy: "raw assets remain under storage and are bound by explicit references",
      auditPassed: true,
      referencedAssetCount: 0,
      referencedBytes: 0,
      referencedAssets: [],
      unreferencedStorage: {
        totalFiles: 0,
        totalBytes: 0,
        unreferencedFiles: 0,
        unreferencedBytes: 0,
        byTopLevel: [],
      },
    },
    scopePolicy: {
      inventoryStates: ["tracked", "untracked", "ignored"],
      sourceCandidateIncludes: "all tracked release source",
      rawStoragePolicy: "referenced storage is external to the public candidate",
      reasonDescriptions: {
        trackedCandidateFile: "Tracked repository content is included.",
      },
    },
    captureConsistency: {
      sourceCommitStable: true,
      gitTreeStable: true,
      branchStable: true,
      statusStable: true,
    },
    gate: {
      gateId: "G1",
      status: "PASS",
      findingCount: 0,
    },
    findings: [],
  };
}

function capability({ id, classification, role, approvals }) {
  return {
    capabilityId: id,
    name: `${id} capability`,
    classification,
    reason: `${classification} scope decision with explicit review`,
    classificationExpiresAtUtc: "2027-07-19T00:00:00Z",
    accountableRole: role,
    targetDateUtc: "2027-06-01T00:00:00Z",
    escalationPath: [`Escalate to ${role}`, "Escalate to Release"],
    overdueAction: "Block the related production claim and approve a revised target.",
    approvals,
  };
}

function schedule(scopeItemIds) {
  return {
    scopeItemIds,
    targetDateUtc: "2027-06-01T00:00:00Z",
    escalationPath: ["Escalate to the accountable owner", "Escalate to Release"],
    overdueAction: "Keep the item open and block its dependent production gate.",
  };
}

function makeWaiver(document, controlCategory) {
  const approvals = ["Security", "Data", "Operations", "Release"].map((role, index) => {
    const source = structuredClone(ownerFor(document, role).approval);
    source.approvalId = `waiver-${role.toLowerCase()}-${index}`;
    return source;
  });
  return {
    decisionId: `decision-${controlCategory}`,
    controlCategory,
    relatedGateIds: ["G0"],
    relatedFindingIds: [],
    businessReason: "A bounded business exception is requested without changing the observed fact.",
    verifiedFacts: ["The affected control remains recorded in its actual execution state."],
    compensatingControls: ["Release stays blocked outside the explicitly approved scope."],
    ownerRole: "Release",
    approvals,
    expiresAtUtc: "2027-01-01T00:00:00Z",
    reviewTriggers: ["Candidate content changes", "Environment target changes"],
    rollbackOrForwardRepair: "Remove the exception and execute the original control before release.",
  };
}

function ownerFor(document, role) {
  return document.responsibilityMatrix.owners.find((entry) => entry.role === role);
}

function capabilityFor(document, classification) {
  return document.capabilities.find((entry) => entry.classification === classification);
}

function allApprovals(document) {
  return [
    ...document.responsibilityMatrix.owners.map(({ approval }) => approval).filter(Boolean),
    ...document.capabilities.flatMap(({ approvals }) => approvals),
    ...document.waivers.flatMap(({ approvals }) => approvals),
  ];
}

async function expectFailure(operation, pattern) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof G0ApprovalValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function filePath(url) {
  return decodeURIComponent(url.pathname);
}

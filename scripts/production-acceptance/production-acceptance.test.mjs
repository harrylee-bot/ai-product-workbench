import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
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
  sha256Canonical,
} from "../evidence-ledger.mjs";
import { loadProductionImageInventory } from "../production-image-inventory.mjs";
import {
  createProductionDeploymentConfig,
  deploymentConfigBinding,
} from "../production-deployment-config.mjs";
import { productionDeploymentConfigFixtureEnvironment } from "../fixtures/production-deployment-config-fixture.mjs";
import { productionApprovalSignaturePayload } from "../verify-workbench-hard-cut-acceptance.mjs";
import { loadProductionTrustPolicy } from "../workbench-production-trust-policy.mjs";
import { createProductionBuildConfiguration } from "../write-production-build-configuration.mjs";
import {
  HARD_CUT_ACCEPTANCE_PACKAGE_SCHEMA_VERSION,
  PRODUCTION_APPROVAL_SET_SCHEMA_VERSION,
  assembleProductionAcceptancePackage,
} from "./assemble-package.mjs";
import { createStrictAjv2020 } from "./schema.mjs";
import {
  DEFAULT_CONTROL_CATALOG_PATH,
  ProductionAcceptanceContractError,
  assertGateEntriesMatchCatalog,
  loadProductionAcceptanceControlCatalog,
} from "./catalog.mjs";
import {
  collectProductionAcceptanceEvidence,
  evaluateThreshold,
  loadProductionControlObservation,
} from "./collect.mjs";
import { executionForControl } from "./control-execution-registry.mjs";
import {
  PRODUCTION_G11_MANIFEST_EVIDENCE_KIND,
  PRODUCTION_G11_REAL_STACK_CONTROL_IDS,
  loadProductionG11RealStackManifest,
  productionG11ServerObserverReceiptPayload,
} from "./g11-real-stack-manifest.mjs";
import {
  createDiagnosticG11Fixture,
  createDiagnosticG11SanitizedTrace,
} from "./g11-test-fixture.mjs";
import {
  productionG11OriginPolicySha256,
  productionG11ScenarioPlan,
} from "./g11-browser-evidence-contract.mjs";
import { materializeProductionObservationSource } from "./materialize-source.mjs";
import { prepareProductionApprovalPayload } from "./prepare-approval-payload.mjs";
import {
  createProductionAcceptancePlan,
  loadProductionAcceptancePlan,
} from "./plan.mjs";
import { runProductionControl } from "./run-control.mjs";

const PLAN_CREATED_AT = "2026-07-19T06:00:00Z";
const OBSERVED_AT = "2026-07-19T07:00:00Z";
const COLLECTED_AT = "2026-07-19T07:15:00Z";
const ACCEPTED_AT = "2026-07-19T07:45:00Z";
const PACKAGE_CREATED_AT = "2026-07-19T08:00:00Z";
const VALIDATION_NOW = new Date("2026-07-19T09:00:00Z");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("catalog is complete and ledger controls cannot add unapproved tools", async () => {
  const catalog = await loadProductionAcceptanceControlCatalog();
  assert.equal(catalog.byControl.size, 48);
  assert.deepEqual([...catalog.byGate.keys()], ["G5", "G6", "G7", "G8", "G9", "G10", "G11"]);
  const gate = catalog.byGate.get("G5");
  const entries = gate.controls.map((control) => catalogEntry(gate.gateId, control));
  assert.equal(assertGateEntriesMatchCatalog({ gateId: gate.gateId, entries, catalog }), true);
  entries[0].toolVersions.push({ name: "unapproved-wrapper", version: "1.0.0" });
  assert.throws(
    () => assertGateEntriesMatchCatalog({ gateId: gate.gateId, entries, catalog }),
    /toolVersions must exactly match/u,
  );
});

test("production observation workflow is read-only, pinned, and independent from G12", async () => {
  const workflow = YAML.parse(await readFile(
    path.join(repoRoot, ".github/workflows/workbench-production-observation.yml"),
    "utf8",
  ));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  const job = workflow.jobs["collect-production-observations"];
  assert.deepEqual(job["runs-on"], ["self-hosted", "production-observer"]);
  assert.equal(job.environment.name, "production-observation");
  const runSource = job.steps.map((step) => step.run ?? "").join("\n");
  for (const marker of [
    "production-image-inventory.mjs",
    "materialize-source.mjs",
    "production-acceptance/collect.mjs",
    "release-chain.bundle.json",
  ]) assert.match(runSource, new RegExp(marker.replaceAll(".", "\\."), "u"));
  assert.doesNotMatch(runSource, /--enforce|hard-cut:manifest|server-deploy|docker compose down/u);
  for (const step of job.steps) {
    if (!step.uses) continue;
    assert.match(step.uses, /^[^@\s]+@[a-f0-9]{40}$/u);
  }
});

test("observation source materializer validates schema, hashes, and path confinement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-observation-source-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = Buffer.from("evidence\n", "utf8");
  const sourcePath = path.join(root, "source.json");
  const source = {
    schemaVersion: "workbench.production-observation-source.v1",
    files: [{
      path: "raw/evidence.txt",
      sha256: sha256Bytes(content),
      contentBase64: content.toString("base64"),
    }],
  };
  const raw = Buffer.from(canonicalJsonFile(source), "utf8");
  await writeFile(sourcePath, raw);
  const report = await materializeProductionObservationSource({
    sourcePath,
    expectedSha256: sha256Bytes(raw),
    outputRoot: path.join(root, "materialized"),
  });
  assert.equal(report.fileCount, 1);
  assert.equal(await readFile(path.join(report.outputRoot, "raw/evidence.txt"), "utf8"), "evidence\n");

  const unsafe = structuredClone(source);
  unsafe.files[0].path = "raw/../escape.txt";
  const unsafeRaw = Buffer.from(canonicalJsonFile(unsafe), "utf8");
  const unsafePath = path.join(root, "unsafe.json");
  await writeFile(unsafePath, unsafeRaw);
  await assertContractFailure(() => materializeProductionObservationSource({
    sourcePath: unsafePath,
    expectedSha256: sha256Bytes(unsafeRaw),
    outputRoot: path.join(root, "unsafe-output"),
  }), /path|pattern/u);
});

test("production control runner derives every non-Figma G11 observation from one real-stack manifest", async (t) => {
  const fixture = await createPreparedFixture();
  t.after(fixture.cleanup);
  const runnerObservations = path.join(fixture.root, "runner-observations");
  await mkdir(runnerObservations);
  const toolAttestation = await createRunnerToolAttestation(fixture);
  const observationIds = new Map();

  for (const controlId of PRODUCTION_G11_REAL_STACK_CONTROL_IDS) {
    const expected = fixture.catalog.byControl.get(controlId).control;
    const resultPath = path.join(fixture.rawDirectory, "g11", `${controlId}.result.json`);
    await writeCanonical(resultPath, productionControlResult({
      controlId,
      execution: executionForControl(controlId),
      executionEvidence: fixture.g11.manifestReference,
      observedValue: expected.threshold.kind === "boolean" ? false : 99,
      toolAttestation,
    }));
    const outputPath = path.join(runnerObservations, `${controlId}.json`);
    await runProductionControl({
      controlId,
      planPath: fixture.planPath,
      resultPath,
      evidenceRoot: fixture.evidenceRoot,
      trustPolicyPath: fixture.trustPolicyPath,
      expectedTrustPolicySha256: fixture.trustPolicySha256,
      outputPath,
    });
    const loaded = await loadProductionControlObservation({ sourcePath: outputPath });
    assert.equal(loaded.observation.result.executionStatus, "PASS");
    assert.equal(loaded.observation.result.observedValue, expected.threshold.kind === "boolean" ? true : 0);
    assert.equal(loaded.observation.evidence.length, fixture.g11.observationEvidence.length);
    assert.equal(
      loaded.observation.evidence.filter(({ kind }) => kind === PRODUCTION_G11_MANIFEST_EVIDENCE_KIND).length,
      1,
    );
    observationIds.set(controlId, loaded.observation.observationId);
  }

  assert.equal(new Set(observationIds.values()).size, PRODUCTION_G11_REAL_STACK_CONTROL_IDS.length);
  const controlId = PRODUCTION_G11_REAL_STACK_CONTROL_IDS[0];
  const repeatedPath = path.join(runnerObservations, `${controlId}.repeat.json`);
  await runProductionControl({
    controlId,
    planPath: fixture.planPath,
    resultPath: path.join(fixture.rawDirectory, "g11", `${controlId}.result.json`),
    evidenceRoot: fixture.evidenceRoot,
    trustPolicyPath: fixture.trustPolicyPath,
    expectedTrustPolicySha256: fixture.trustPolicySha256,
    outputPath: repeatedPath,
  });
  const repeated = await loadProductionControlObservation({ sourcePath: repeatedPath });
  assert.equal(repeated.observation.observationId, observationIds.get(controlId));
});

test("G11 real-stack verifier rejects fixture, binding, matrix, flow, and screenshot tampering", async (t) => {
  const fixture = await createPreparedFixture();
  t.after(fixture.cleanup);
  const original = structuredClone(fixture.g11.manifest);
  const load = async (manifest = original, referenceOverride) => {
    const reference = await rewriteG11Manifest(fixture.g11.manifestPath, manifest);
    return loadProductionG11RealStackManifest({
      reference: referenceOverride ?? reference,
      evidenceRoot: fixture.evidenceRoot,
      plan: fixture.plan,
      executedAtUtc: OBSERVED_AT,
      trustPolicy: fixture.trustPolicy,
    });
  };
  assert.equal((await load()).evidence.length, fixture.g11.evidence.length);

  const scenarios = [
    {
      name: "candidate binding",
      pattern: /binding mismatch/u,
      mutate(manifest) { manifest.binding.candidateId = `sha256:${"9".repeat(64)}`; },
    },
    {
      name: "controlled provider",
      pattern: /controlled-local|fixture marker/u,
      mutate(manifest) { manifest.deployment.provider.id = "controlled-local-deerflow"; },
    },
    {
      name: "HTTP origin",
      pattern: /HTTPS origin/u,
      mutate(manifest) { manifest.deployment.webOrigin = "http://workbench.example.com"; },
    },
    {
      name: "reserved example origin",
      pattern: /local, reserved, private, or documentation-only/u,
      mutate(manifest) { manifest.deployment.webOrigin = "https://workbench.example.com"; },
    },
    {
      name: "single browser",
      pattern: /browsers|fewer than 3/u,
      mutate(manifest) { manifest.browsers = manifest.browsers.slice(0, 1); },
    },
    {
      name: "missing matrix cell",
      pattern: /54|fewer than 54/u,
      mutate(manifest) { manifest.visualMatrix.pop(); },
    },
    {
      name: "duplicate matrix cell",
      pattern: /54 unique/u,
      mutate(manifest) { manifest.visualMatrix[53] = structuredClone(manifest.visualMatrix[0]); },
    },
    {
      name: "flow self-report",
      pattern: /status differs/u,
      mutate(manifest) {
        manifest.flows.find(({ flowId }) => flowId === "prd").checks.checksumVerified = false;
      },
    },
    {
      name: "long Run boundary",
      pattern: /status differs/u,
      mutate(manifest) {
        manifest.flows.find(({ flowId }) => flowId === "long-run-7686-plus").checks.observedEventCount = 7_685;
      },
    },
    {
      name: "Run cancel coverage",
      pattern: /status differs/u,
      mutate(manifest) {
        manifest.flows.find(({ flowId }) => flowId === "run-canvas-sse-artifact").checks.cancelPassed = false;
      },
    },
    {
      name: "screenshot hash",
      pattern: /screenshot cannot be verified/u,
      mutate(manifest) { manifest.visualMatrix[0].screenshot.sha256 = "0".repeat(64); },
    },
  ];
  for (const scenario of scenarios) {
    const manifest = structuredClone(original);
    scenario.mutate(manifest);
    await assertContractFailure(() => load(manifest), scenario.pattern);
  }

  const correctReference = await rewriteG11Manifest(fixture.g11.manifestPath, original);
  await assertContractFailure(() => load(original, {
    ...correctReference,
    sha256: "1".repeat(64),
  }), /manifest cannot be verified/u);
});

test("G11 verifier derives pixels, motion, and flow coverage from referenced artifacts", async (t) => {
  await t.test("rejects distinct screenshot URIs that decode to the same state pixels", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const source = manifest.visualMatrix.find((cell) => (
      cell.browser === "chromium" && cell.viewport === "375x812" && cell.motion === "normal" && cell.state === "prd-active"
    ));
    const target = manifest.visualMatrix.find((cell) => (
      cell.browser === "chromium" && cell.viewport === "375x812" && cell.motion === "normal" && cell.state === "prd-pending"
    ));
    const sourceBytes = await readFile(g11ArtifactPath(fixture.evidenceRoot, source.screenshot));
    await writeFile(g11ArtifactPath(fixture.evidenceRoot, target.screenshot), sourceBytes);
    target.screenshot.sha256 = sha256Bytes(sourceBytes);
    await rewriteG11CellReceipt(fixture.evidenceRoot, target, (receipt) => {
      receipt.screenshot = target.screenshot;
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /distinct decoded pixels/u);
  });

  await t.test("rejects normal motion whose referenced before and after frames are identical", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix.find((candidate) => candidate.motion === "normal");
    const before = await readFile(g11ArtifactPath(fixture.evidenceRoot, cell.frameBefore));
    await writeFile(g11ArtifactPath(fixture.evidenceRoot, cell.frameAfter), before);
    cell.frameAfter.sha256 = sha256Bytes(before);
    await rewriteG11CellReceipt(fixture.evidenceRoot, cell, (receipt) => {
      receipt.frameAfter = cell.frameAfter;
      receipt.framePixelDiffRatio = 0;
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /normal pixel-diff threshold/u);
  });

  await t.test("rejects an untyped non-JSON flow receipt even when its hash is updated", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "prd");
    const receipt = flow.evidence.find(({ kind }) => kind === "browser-flow-receipt");
    const bytes = Buffer.from("x", "utf8");
    await writeFile(g11ArtifactPath(fixture.evidenceRoot, receipt), bytes);
    receipt.sha256 = sha256Bytes(bytes);
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /flow receipt is not valid canonical JSON/u);
  });

  await t.test("rejects header and body fields in a sanitized trace", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateNetwork(network) {
        network.requests[0].headers = { authorization: "Bearer must-not-enter-evidence" };
        network.requests[0].body = "private prompt";
      },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /strict evidence contract/u);
  });

  await t.test("rejects an embedded native trace entry", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      extraEntries: [["trace.trace", Buffer.from("raw private trace content", "utf8")]],
    });
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /not a valid canonical sanitized ZIP trace/u,
    );
  });

  await t.test("rejects cookie and query values in a sanitized trace", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateMetadata(metadata) {
        metadata.cookies = ["session=must-not-enter-evidence"];
        metadata.queryValues = { token: "must-not-enter-evidence" };
      },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /strict evidence contract/u);
  });

  await t.test("rejects a native trace hash that differs from its independent receipt binding", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, { nativeTraceSha256: "f".repeat(64) });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /nativeTraceSha256.*bound receipt/u);
  });

  await t.test("rejects browser, viewport, or motion metadata that differs from its receipt", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateMetadata(metadata) {
        metadata.browser.name = metadata.browser.name === "chromium" ? "firefox" : "chromium";
        metadata.viewport = { id: "768x1024", width: 768, height: 1024 };
        metadata.motion = metadata.motion === "normal" ? "reduced" : "normal";
      },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /metadata (?:browser|viewport|motion).*bound receipt/u);
  });

  await t.test("rejects a flow trace that omits a protected scenario step", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "prd");
    await rewriteG11FlowTrace(fixture.evidenceRoot, flow, (coverage) => [coverage.steps[0].stepId]);
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /calls must exactly equal the protected scenario step count/u);
  });

  await t.test("rejects trace action or assertion specifications outside the protected scenario", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateCalls(calls) {
        calls.calls[0].actionId = "unapproved-action";
        calls.calls[0].assertions[0].assertionSpecId = "unapproved-assertion";
      },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /calls\[0\] identity is invalid|assertions\[0\].*identity is invalid/u);
  });

  await t.test("rejects private remote endpoints and trace scenario metadata drift", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateMetadata(metadata) { metadata.originPolicySha256 = "0".repeat(64); },
      mutateNetwork(network) { network.requests[0].remoteAddress = "127.0.0.1"; },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /originPolicySha256.*bound receipt|remote endpoint or origin-policy/u);
  });

  await t.test("rejects a visual trace that omits its required SSE evidence", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateMetadata(metadata) {
        metadata.sseCapture.records = [];
      },
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /sufficient flow-bound SSE evidence/u);
  });

  await t.test("rejects insufficient flow-bound sanitized SSE evidence", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "long-run-7686-plus");
    await rewriteG11FlowTrace(
      fixture.evidenceRoot,
      flow,
      (coverage) => coverage.steps.map(({ stepId }) => stepId),
      (metadata) => { metadata.sseCapture.records = metadata.sseCapture.records.slice(0, 2); },
    );
    await resyncG11ObserverReceipt(fixture, flow);
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /sufficient flow-bound SSE evidence/u);
  });

  await t.test("rejects non-RunEvent names and malformed stream identities", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "prd");
    await rewriteG11FlowTrace(
      fixture.evidenceRoot,
      flow,
      (coverage) => coverage.steps.map(({ stepId }) => stepId),
      (metadata) => {
        metadata.sseCapture.records[0].streamId = "not-a-sha256";
        metadata.sseCapture.records[0].eventName = "run.stage";
      },
    );
    await resyncG11ObserverReceipt(fixture, flow);
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /contiguous sanitized RunEvent in its stream and reconnect cursor/u,
    );
  });

  await t.test("rejects a sequence gap within one stream and reconnect cursor", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "refresh-reconnect");
    await rewriteG11FlowTrace(
      fixture.evidenceRoot,
      flow,
      (coverage) => coverage.steps.map(({ stepId }) => stepId),
      (metadata) => { metadata.sseCapture.records[3].sequence += 1; },
    );
    await resyncG11ObserverReceipt(fixture, flow);
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /contiguous sanitized RunEvent in its stream and reconnect cursor/u,
    );
  });

  await t.test("rejects refresh evidence without an advanced reconnect cursor", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "refresh-reconnect");
    await rewriteG11FlowTrace(
      fixture.evidenceRoot,
      flow,
      (coverage) => coverage.steps.map(({ stepId }) => stepId),
      (metadata) => {
        const streamId = metadata.sseCapture.records[0].streamId;
        metadata.sseCapture.records = [
          { streamId, afterSequence: 0, eventName: "run.generation.stage.changed", sequence: 1 },
          { streamId, afterSequence: 0, eventName: "run.completed", sequence: 2 },
        ];
      },
    );
    await resyncG11ObserverReceipt(fixture, flow);
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /sufficient flow-bound SSE evidence/u,
    );
  });

  await t.test("rejects more than 12000 sanitized SSE records", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "long-run-7686-plus");
    await rewriteG11FlowTrace(
      fixture.evidenceRoot,
      flow,
      (coverage) => coverage.steps.map(({ stepId }) => stepId),
      (metadata) => {
        const streamId = metadata.sseCapture.records[0].streamId;
        metadata.sseCapture.records = Array.from({ length: 12_001 }, (_, index) => ({
          streamId,
          afterSequence: 0,
          eventName: index === 0 ? "run.started" : index === 12_000 ? "run.completed" : "message.delta",
          sequence: index + 1,
        }));
      },
    );
    await resyncG11ObserverReceipt(fixture, flow);
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /complete, bounded sanitized SSE sequence/u,
    );
  });

  await t.test("rejects api as an origin class because API is a path class", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    await rewriteG11CellTrace(fixture.evidenceRoot, cell, {
      mutateNetwork(network) {
        network.requests[0].originClass = "api";
        network.requests[0].pathClass = "api";
      },
    });
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /non-categorical or invalid metadata|remote endpoint or origin-policy attribution/u,
    );
  });

  await t.test("rejects a tampered signed server observer receipt", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "account-project");
    const reference = flow.evidence.find(({ kind }) => kind === "server-observer-receipt");
    const receiptPath = g11ArtifactPath(fixture.evidenceRoot, reference);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const replacement = receipt.signature.value.endsWith("A") ? "B" : "A";
    receipt.signature.value = `${receipt.signature.value.slice(0, -1)}${replacement}`;
    const bytes = Buffer.from(canonicalJsonFile(receipt), "utf8");
    await writeFile(receiptPath, bytes);
    reference.sha256 = sha256Bytes(bytes);
    await assertContractFailure(
      () => loadG11Fixture(fixture, manifest),
      /server observer receipt signature verification failed/u,
    );
  });
});

test("G11 verifier converts malformed receipt inputs into contract failures", async (t) => {
  await t.test("empty cell receipt", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    const bytes = Buffer.from("{}\n", "utf8");
    await writeFile(g11ArtifactPath(fixture.evidenceRoot, cell.receipt), bytes);
    cell.receipt.sha256 = sha256Bytes(bytes);
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /receipt.*strict evidence contract/u);
  });

  await t.test("non-finite JSON number", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const cell = manifest.visualMatrix[0];
    const bytes = Buffer.from('{"value":1e400}\n', "utf8");
    await writeFile(g11ArtifactPath(fixture.evidenceRoot, cell.receipt), bytes);
    cell.receipt.sha256 = sha256Bytes(bytes);
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /not valid canonical JSON/u);
  });

  await t.test("non-string flow step identifiers", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "prd");
    await rewriteG11FlowReceipt(fixture.evidenceRoot, flow, (receipt) => {
      receipt.coverage[0].steps[0].stepId = 1;
      receipt.coverage[0].steps[1].stepId = null;
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /steps must prove/u);
  });

  await t.test("null flow coverage cell", async (t) => {
    const fixture = await createPreparedFixture();
    t.after(fixture.cleanup);
    const manifest = structuredClone(fixture.g11.manifest);
    const flow = manifest.flows.find(({ flowId }) => flowId === "prd");
    await rewriteG11FlowReceipt(fixture.evidenceRoot, flow, (receipt) => {
      receipt.coverage[0] = null;
    });
    await assertContractFailure(() => loadG11Fixture(fixture, manifest), /coverage.*must be an object/u);
  });
});

test("collection independently replays G11 manifest values instead of trusting hand-built observations", async (t) => {
  const fixture = await createPreparedFixture();
  t.after(fixture.cleanup);
  const manifest = structuredClone(fixture.g11.manifest);
  manifest.unexpectedConsoleErrors.push({
    browser: "chromium",
    viewport: "1440x900",
    motion: "normal",
    sourceClass: "workbench-web",
    type: "error",
    count: 1,
  });
  const manifestReference = await rewriteG11Manifest(fixture.g11.manifestPath, manifest);
  for (const controlId of PRODUCTION_G11_REAL_STACK_CONTROL_IDS) {
    const observationPath = path.join(fixture.observationsDirectory, `${controlId}.json`);
    const observation = JSON.parse(await readFile(observationPath, "utf8"));
    const reference = observation.evidence.find(({ kind }) => kind === PRODUCTION_G11_MANIFEST_EVIDENCE_KIND);
    reference.sha256 = manifestReference.sha256;
    await writeCanonical(observationPath, observation);
  }
  await assertContractFailure(
    () => collectPrepared(fixture, "g11-replay-tamper"),
    /console error summary does not match complete cell and flow capture receipts/u,
  );
});

test("plan, collection, and v3 assembly complete one candidate-bound path", async (t) => {
  const fixture = await createAssemblyFixture();
  t.after(fixture.cleanup);
  const loadedPlan = await loadProductionAcceptancePlan({
    planPath: fixture.planPath,
    catalog: fixture.catalog,
  });
  assert.equal(loadedPlan.plan.payload.binding.digests.controlCatalogSha256, fixture.catalog.sha256);
  assert.equal(fixture.collectionResult.status, "PASS");

  const result = await assembleProductionAcceptancePackage(fixture.assemblyOptions);
  assert.equal(result.status, "PASS");
  assert.equal(result.document.schemaVersion, HARD_CUT_ACCEPTANCE_PACKAGE_SCHEMA_VERSION);
  assert.equal(result.document.gates.length, 7);
  assert.equal(result.document.approvals.length, 4);
  assert.equal(result.document.productionImages.manifestSha256, fixture.imageManifestSha256);
  assert.equal(result.document.controlCatalog.sha256, fixture.catalog.sha256);
  assert.equal(result.document.hardCutManifest.path, "manifest.json");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(JSON.parse(await readFile(result.outputPath, "utf8")), result.document);
});

test("approval payload command freezes the v3 implementer and time envelope", async (t) => {
  const fixture = await createAssemblyFixture();
  t.after(fixture.cleanup);
  const approvalSet = JSON.parse(await readFile(fixture.approvalsPath, "utf8"));
  const security = approvalSet.approvals[0];
  const result = await prepareProductionApprovalPayload({
    collectionRoot: fixture.collectionRoot,
    hardCutRoot: fixture.hardCutRoot,
    productionImageManifestPath: fixture.imageManifestPath,
    deploymentConfigManifestPath: fixture.deploymentConfigManifestPath,
    deploymentConfigBundlePath: fixture.deploymentConfigBundlePath,
    certificateIdentity: "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production",
    certificateOidcIssuer: "https://token.actions.githubusercontent.com",
    githubRunId: "81234",
    githubRunAttempt: 1,
    trustPolicyPath: fixture.trustPolicyPath,
    expectedTrustPolicySha256: fixture.assemblyOptions.expectedTrustPolicySha256,
    verifyDeploymentConfigBlob: () => true,
    role: security.role,
    approverId: security.approverId,
    keyId: security.signature.keyId,
    signedAtUtc: security.signedAtUtc,
    approvalEvidencePath: path.join(fixture.approvalEvidenceRoot, "security.json"),
    implementerId: fixture.assemblyOptions.implementerId,
    acceptedAtUtc: fixture.assemblyOptions.acceptedAtUtc,
    createdAtUtc: fixture.assemblyOptions.createdAtUtc,
    outputPath: path.join(fixture.root, "security-approval-payload.json"),
    now: VALIDATION_NOW,
  });
  assert.equal(result.payload.schemaVersion, "workbench.production-approval-signature.v3");
  assert.deepEqual(result.payload.acceptanceEnvelope, {
    implementerId: fixture.assemblyOptions.implementerId,
    createdAtUtc: fixture.assemblyOptions.createdAtUtc,
    acceptedAtUtc: fixture.assemblyOptions.acceptedAtUtc,
  });
  assert.equal(result.approval.evidenceSha256, security.evidenceSha256);
  assert.equal(await readFile(result.outputPath, "utf8"), canonicalJsonFile(result.payload));
  const signatureSchema = JSON.parse(await readFile(
    path.join(repoRoot, "docs/evidence/production-approval-signature.schema.json"),
    "utf8",
  ));
  const validate = createStrictAjv2020().compile(signatureSchema);
  assert.equal(validate(result.payload), true, JSON.stringify(validate.errors));
});

test("collector rejects a missing control and any duplicate or untracked observation", async (t) => {
  const missing = await createPreparedFixture();
  const extra = await createPreparedFixture();
  t.after(missing.cleanup);
  t.after(extra.cleanup);
  await unlink(path.join(missing.observationsDirectory, `${missing.controls[0].control.controlId}.json`));
  await assertContractFailure(() => collectPrepared(missing, "missing-output"), /exactly one regular/u);
  await writeCanonical(path.join(extra.observationsDirectory, "G5.DUPLICATE.json"), { duplicate: true });
  await assertContractFailure(() => collectPrepared(extra, "extra-output"), /exactly one regular/u);
});

test("collector recomputes every threshold and rejects a false PASS claim", async (t) => {
  const fixture = await createPreparedFixture();
  t.after(fixture.cleanup);
  const selected = fixture.controls.find(({ control }) => control.threshold.kind === "boolean");
  const observationPath = path.join(fixture.observationsDirectory, `${selected.control.controlId}.json`);
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  observation.result.observedValue = !selected.control.threshold.expected;
  assert.equal(evaluateThreshold(selected.control.threshold, observation.result.observedValue), false);
  await writeCanonical(observationPath, observation);
  await assertContractFailure(
    () => collectPrepared(fixture, "threshold-output"),
    /claims PASS.*does not meet/u,
  );
});

test("collector rejects tampered hashes, path traversal, and unrelated tool provenance", async (t) => {
  const tampered = await createPreparedFixture();
  const traversal = await createPreparedFixture();
  const provenance = await createPreparedFixture();
  t.after(tampered.cleanup);
  t.after(traversal.cleanup);
  t.after(provenance.cleanup);
  const first = tampered.controls[0].control;
  const rawPath = tampered.rawPaths.get(first.controlId);
  await writeFile(rawPath, "tampered\n", "utf8");
  await assertContractFailure(() => collectPrepared(tampered, "tampered-output"), /SHA-256 mismatch/u);

  const traversalControl = traversal.controls[0].control;
  const observationPath = path.join(traversal.observationsDirectory, `${traversalControl.controlId}.json`);
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  observation.evidence[0].uri = "file:./raw/../escape.json";
  await writeCanonical(observationPath, observation);
  await assertContractFailure(() => collectPrepared(traversal, "traversal-output"), /unsafe|immutable/u);

  const provenanceControl = provenance.controls[0].control;
  const provenanceObservationPath = path.join(
    provenance.observationsDirectory,
    `${provenanceControl.controlId}.json`,
  );
  const provenanceObservation = JSON.parse(await readFile(provenanceObservationPath, "utf8"));
  provenanceObservation.toolAttestation.provenanceSubjectSha256 = "0".repeat(64);
  await writeCanonical(provenanceObservationPath, provenanceObservation);
  await assertContractFailure(
    () => collectPrepared(provenance, "provenance-output"),
    /provenance subject does not match/u,
  );
});

test("assembler replays observations and rejects a hand-forged PASS ledger", async (t) => {
  const fixture = await createAssemblyFixture();
  t.after(fixture.cleanup);
  await forgeFailingObservationAsPass(fixture);
  await assertContractFailure(
    () => assembleProductionAcceptancePackage(fixture.assemblyOptions),
    /observation replay failed|claims PASS.*threshold/u,
  );
});

test("assembler rejects collection hash tampering and forged approval signatures", async (t) => {
  const tampered = await createAssemblyFixture();
  const forged = await createAssemblyFixture();
  t.after(tampered.cleanup);
  t.after(forged.cleanup);
  const rawEvidence = [...tampered.rawPaths.values()][0];
  const packagedRaw = path.join(tampered.collectionRoot, path.relative(tampered.evidenceRoot, rawEvidence));
  await writeFile(packagedRaw, "changed after collection\n", "utf8");
  await assertContractFailure(
    () => assembleProductionAcceptancePackage(tampered.assemblyOptions),
    /ledger verification failed|SHA-256 mismatch/u,
  );

  const approvalSet = JSON.parse(await readFile(forged.approvalsPath, "utf8"));
  const signature = approvalSet.approvals[0].signature.value;
  approvalSet.approvals[0].signature.value = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await writeCanonical(forged.approvalsPath, approvalSet);
  await assertContractFailure(
    () => assembleProductionAcceptancePackage(forged.assemblyOptions),
    /signature verification failed|signature validation failed/u,
  );
});

test("assembler runs hard-cut enforce and rejects a receipt ledger changed after signing", async (t) => {
  const fixture = await createAssemblyFixture();
  t.after(fixture.cleanup);
  const receiptLedger = path.join(
    fixture.hardCutRoot,
    "hard-cut-ledgers/hard-cut-production-acceptance.json",
  );
  const raw = await readFile(receiptLedger);
  await writeFile(receiptLedger, Buffer.concat([raw, Buffer.from("\n")]));
  await assertContractFailure(
    () => assembleProductionAcceptancePackage(fixture.assemblyOptions),
    /hard-cut enforce.*(?:SHA-256 mismatch|canonical JSON)/u,
  );
});

test("production outputs are confined outside the repository and source roots", async (t) => {
  const fixture = await createAssemblyFixture();
  t.after(fixture.cleanup);
  await assertContractFailure(
    () => assembleProductionAcceptancePackage({
      ...fixture.assemblyOptions,
      outputPath: path.join(fixture.collectionRoot, "nested-package.json"),
    }),
    /must not overlap/u,
  );
  await assertContractFailure(
    () => collectProductionAcceptanceEvidence({
      planPath: fixture.planPath,
      observationsDirectory: fixture.observationsDirectory,
      evidenceRoot: fixture.evidenceRoot,
      trustPolicyPath: fixture.trustPolicyPath,
      expectedTrustPolicySha256: fixture.trustPolicySha256,
      outputRoot: path.join(path.dirname(new URL(import.meta.url).pathname), "forbidden-output"),
      collectedAtUtc: COLLECTED_AT,
    }),
    /outside the source repository/u,
  );
});

async function createAssemblyFixture() {
  const fixture = await createPreparedFixture();
  await collectPrepared(fixture, "collection");
  const hardCutRoot = path.join(fixture.root, "hard-cut-source");
  const approvalEvidenceRoot = path.join(fixture.root, "approval-evidence");
  await mkdir(hardCutRoot);
  await mkdir(approvalEvidenceRoot);
  const binding = fixture.plan.payload.binding;
  const summary = JSON.parse(await readFile(path.join(fixture.collectionRoot, "collection.json"), "utf8"));
  const candidate = {
    candidateId: binding.candidateId,
    sourceCommit: binding.commitSha,
    signedTag: binding.tag,
    chainId: binding.releaseChainId,
  };
  const gates = summary.payload.gates.map((gate) => ({
    gateId: gate.gateId,
    status: gate.status,
    observedAtUtc: gate.observedAtUtc,
    candidate,
    evidencePath: gate.ledger.path,
    evidenceSha256: gate.ledger.sha256,
  }));
  const productionImages = {
    manifestSha256: fixture.imageManifestSha256,
    images: binding.digests.images,
  };
  const controlCatalog = {
    schemaVersion: fixture.catalog.document.schemaVersion,
    sha256: fixture.catalog.sha256,
  };
  const signers = fixture.approvalSigners;
  const keys = [...fixture.trustPolicyDocument.keys];
  const approvalAuthorities = [...fixture.trustPolicyDocument.approvalAuthorities];

  const receiptSigners = fixture.hardCutReceiptSigners;
  const receiptAuthorities = [...fixture.trustPolicyDocument.receiptAuthorities];
  const receiptFor = async ({ scopeId, threshold, signer, executedAtUtc, signedAtUtc }) => {
    return createHardCutReceipt({
      hardCutRoot,
      binding,
      scopeId,
      threshold,
      signer,
      executedAtUtc,
      signedAtUtc,
    });
  };
  const productionAcceptance = await receiptFor({
    scopeId: "hard-cut.production-acceptance",
    threshold: "true",
    signer: receiptSigners.acceptance,
    executedAtUtc: "2026-07-19T07:20:00Z",
    signedAtUtc: "2026-07-19T07:21:00Z",
  });
  const trafficSwitch = await receiptFor({
    scopeId: "hard-cut.traffic-switch",
    threshold: "true",
    signer: receiptSigners.traffic,
    executedAtUtc: "2026-07-19T07:50:00Z",
    signedAtUtc: "2026-07-19T07:51:00Z",
  });
  const rollbackWindowClosure = await receiptFor({
    scopeId: "hard-cut.rollback-window-closure",
    threshold: "zero",
    signer: receiptSigners.closure,
    executedAtUtc: "2026-07-19T07:55:00Z",
    signedAtUtc: "2026-07-19T07:56:00Z",
  });
  const externalEntries = [];
  for (const kind of ["container", "database", "image", "log", "network", "object-prefix", "secret", "volume"]) {
    const scopeId = `legacy-${kind}`;
    const receipt = await receiptFor({
      scopeId,
      threshold: "zero",
      signer: receiptSigners.closure,
      executedAtUtc: "2026-07-19T07:10:00Z",
      signedAtUtc: "2026-07-19T07:11:00Z",
    });
    externalEntries.push({
      id: scopeId,
      kind,
      scope: `production:${kind}`,
      provider: "fixture-provider",
      targets: [`fixture-${kind}`],
      state: "removed",
      reason: `Fixture proves legacy ${kind} resources are absent.`,
      preconditions: ["The candidate binding is frozen."],
      receipt,
    });
  }
  const hardCutManifest = {
    version: 3,
    product: "产品工作台",
    technicalIdentifier: "workbench",
    status: "completed",
    policy: {
      allowConversationMigration: false,
      allowCompatibilityLayer: false,
      allowDualWrite: false,
      preserveKnowledgeVault: true,
      preserveOnlyReferencedStorage: true,
    },
    candidateBinding: binding,
    cutoverReceipts: {
      productionAcceptance,
      trafficSwitch,
      rollbackWindowClosure,
    },
    entries: externalEntries,
  };
  const hardCutManifestRaw = Buffer.from(canonicalJsonFile(hardCutManifest), "utf8");
  await writeFile(path.join(hardCutRoot, "manifest.json"), hardCutManifestRaw);
  const hardCutManifestDescriptor = {
    path: "manifest.json",
    sha256: sha256Bytes(hardCutManifestRaw),
  };
  const trustPolicy = {
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: binding.environmentId,
    keys,
    approvalAuthorities,
    receiptAuthorities,
  };
  const trustPolicyPath = fixture.trustPolicyPath;
  const trustPolicyRaw = Buffer.from(canonicalJsonFile(trustPolicy), "utf8");
  await writeFile(trustPolicyPath, trustPolicyRaw);
  const approvals = [];
  for (const [index, role] of ["Security", "Data", "Operations", "Release"].entries()) {
    const evidencePath = `approvals/${role.toLowerCase()}.json`;
    const evidenceRaw = Buffer.from(canonicalJsonFile({ role, decision: "APPROVE", reviewedCollection: summary.payload.collectionId }), "utf8");
    await writeFile(path.join(approvalEvidenceRoot, `${role.toLowerCase()}.json`), evidenceRaw);
    const signer = signers.get(role);
    const approval = {
      role,
      decision: "APPROVE",
      approverId: signer.approverId,
      signedAtUtc: `2026-07-19T07:${35 + index}:00Z`,
      evidencePath,
      evidenceSha256: sha256Bytes(evidenceRaw),
      signature: {
        algorithm: "Ed25519",
        keyId: signer.keyId,
        value: "pending",
      },
    };
    approval.signature.value = sign(
      null,
      Buffer.from(canonicalJson(productionApprovalSignaturePayload({
        approval,
        implementerId: "implementer-fixture",
        createdAtUtc: PACKAGE_CREATED_AT,
        acceptedAtUtc: ACCEPTED_AT,
        candidate,
        productionImages,
        deploymentConfig: fixture.deploymentConfig,
        controlCatalog,
        hardCutManifest: hardCutManifestDescriptor,
        gates,
      })), "utf8"),
      signer.privateKey,
    ).toString("base64url");
    approvals.push(approval);
  }
  const approvalsPath = path.join(fixture.root, "approval-set.json");
  await writeCanonical(approvalsPath, {
    schemaVersion: PRODUCTION_APPROVAL_SET_SCHEMA_VERSION,
    approvals,
  });
  Object.assign(fixture, {
    hardCutRoot,
    approvalEvidenceRoot,
    approvalsPath,
    trustPolicyPath,
    assemblyOptions: {
      collectionRoot: fixture.collectionRoot,
      hardCutRoot,
      approvalsPath,
      approvalEvidenceRoot,
      productionImageManifestPath: fixture.imageManifestPath,
      deploymentConfigManifestPath: fixture.deploymentConfigManifestPath,
      deploymentConfigBundlePath: fixture.deploymentConfigBundlePath,
      certificateIdentity: "https://github.com/example/workbench/.github/workflows/workbench-ci.yml@refs/heads/production",
      certificateOidcIssuer: "https://token.actions.githubusercontent.com",
      githubRunId: "81234",
      githubRunAttempt: 1,
      verifyDeploymentConfigBlob: () => true,
      trustPolicyPath,
      expectedTrustPolicySha256: sha256Bytes(trustPolicyRaw),
      implementerId: "implementer-fixture",
      acceptedAtUtc: ACCEPTED_AT,
      createdAtUtc: PACKAGE_CREATED_AT,
      outputPath: path.join(fixture.root, "hard-cut-acceptance-package.json"),
      now: VALIDATION_NOW,
    },
  });
  return fixture;
}

function createTrustedSigner(signerId) {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from(pair.publicKey.export({ type: "spki", format: "der" }));
  const publicKeySha256 = sha256Bytes(publicKeyBytes);
  const keyId = `sha256:${publicKeySha256}`;
  return {
    ...pair,
    signerId,
    keyId,
    trustEntry: {
      keyId,
      algorithm: "Ed25519",
      publicKeySpkiBase64: publicKeyBytes.toString("base64"),
      publicKeySha256,
      validFromUtc: "2026-07-01T00:00:00Z",
      validUntilUtc: "2026-08-01T00:00:00Z",
      revokedAtUtc: null,
    },
  };
}

async function createHardCutReceipt({
  hardCutRoot,
  binding,
  scopeId,
  threshold,
  signer,
  executedAtUtc,
  signedAtUtc,
}) {
  const slug = scopeId.replaceAll(".", "-");
  const rawRelative = `hard-cut-raw/${slug}.json`;
  const ledgerRelative = `hard-cut-ledgers/${slug}.json`;
  const raw = Buffer.from(canonicalJsonFile({
    scopeId,
    observedValue: threshold === "zero" ? 0 : true,
  }), "utf8");
  await mkdir(path.join(hardCutRoot, "hard-cut-raw"), { recursive: true });
  await mkdir(path.join(hardCutRoot, "hard-cut-ledgers"), { recursive: true });
  await writeFile(path.join(hardCutRoot, ...rawRelative.split("/")), raw);
  const entryId = `receipt-${slug}`;
  const ledger = sealEvidenceLedger({
    ledgerId: `ledger-${slug}`,
    createdAtUtc: signedAtUtc,
    binding,
    previousLedger: null,
    entries: [{
      entryId,
      gateId: "G12",
      controlObjective: `Prove ${scopeId} met the hard-cut threshold.`,
      environment: {
        environmentId: binding.environmentId,
        kind: "production",
        description: "Hard-cut fixture production environment.",
        region: "fixture-region",
      },
      prerequisites: ["The candidate binding is frozen."],
      procedure: { kind: "command", command: `verify-hard-cut ${scopeId}` },
      expectedObservation: threshold === "zero" ? "The residual count is zero." : "The control is true.",
      threshold: threshold === "zero"
        ? { kind: "number", operator: "eq", expected: 0, unit: "objects" }
        : { kind: "boolean", operator: "eq", expected: true },
      findingStatus: "CONFIRMED",
      executionStatus: "PASS",
      evidenceLevel: "E1",
      executedAtUtc,
      executor: { id: signer.signerId, kind: "automation" },
      binding,
      toolVersions: [{ name: "hard-cut-fixture", version: "1.0.0" }],
      evidence: [{ uri: `file:./${rawRelative}`, sha256: sha256Bytes(raw) }],
      retryRecords: [],
      relatedFindingsOrDecisions: [{ kind: "decision", id: scopeId }],
    }],
  });
  const ledgerRaw = Buffer.from(canonicalJsonFile(ledger), "utf8");
  await writeFile(path.join(hardCutRoot, ...ledgerRelative.split("/")), ledgerRaw);
  const receipt = {
    schemaVersion: "workbench.hard-cut-receipt.v2",
    scopeId,
    ledger: {
      ledgerId: ledger.payload.ledgerId,
      entryId,
      uri: `file:./${ledgerRelative}`,
      sha256: sha256Bytes(ledgerRaw),
    },
    signedAtUtc,
    validUntilUtc: "2026-07-20T08:00:00Z",
    signature: {
      algorithm: "Ed25519",
      keyId: signer.keyId,
      value: "pending",
    },
  };
  receipt.signature.value = sign(null, Buffer.from(canonicalJson({
    schemaVersion: receipt.schemaVersion,
    scopeId: receipt.scopeId,
    keyId: receipt.signature.keyId,
    candidateBinding: binding,
    ledger: receipt.ledger,
    signedAtUtc: receipt.signedAtUtc,
    validUntilUtc: receipt.validUntilUtc,
  }), "utf8"), signer.privateKey).toString("base64url");
  return receipt;
}

async function createPreparedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-production-acceptance-"));
  const evidenceRoot = path.join(root, "evidence-source");
  const observationsDirectory = path.join(evidenceRoot, "observations");
  const rawDirectory = path.join(evidenceRoot, "raw");
  await mkdir(observationsDirectory, { recursive: true });
  await mkdir(rawDirectory, { recursive: true });
  const catalog = await loadProductionAcceptanceControlCatalog();
  const catalogRaw = await readFile(DEFAULT_CONTROL_CATALOG_PATH);
  assert.equal(sha256Bytes(catalogRaw), catalog.sha256);
  const candidate = {
    candidateId: `sha256:${"a".repeat(64)}`,
    sourceCommit: "b".repeat(40),
    signedTag: "workbench-v1.0.0-rc1",
    chainId: `sha256:${"c".repeat(64)}`,
  };
  const imageManifest = productionImageManifestFixture(candidate);
  const imageManifestPath = path.join(root, "production-image-manifest.json");
  const imageManifestRaw = Buffer.from(canonicalJsonFile(imageManifest), "utf8");
  await writeFile(imageManifestPath, imageManifestRaw);
  const imageManifestSha256 = sha256Bytes(imageManifestRaw);
  const deploymentConfig = createProductionDeploymentConfig({
    candidateId: candidate.candidateId,
    sourceCommit: candidate.sourceCommit,
    signedTag: candidate.signedTag,
    releaseChainId: candidate.chainId,
    imageManifest,
    imageManifestSha256,
    githubRunId: "81234",
    githubRunAttempt: 1,
    infrastructureEnvironment: productionDeploymentConfigFixtureEnvironment(),
  });
  const deploymentConfigManifestPath = path.join(root, "production-deployment-config.json");
  const deploymentConfigBundlePath = path.join(root, "production-deployment-config.bundle.json");
  const deploymentConfigRaw = Buffer.from(canonicalJsonFile(deploymentConfig), "utf8");
  await writeFile(deploymentConfigManifestPath, deploymentConfigRaw);
  await writeFile(deploymentConfigBundlePath, "{}\n");
  const deploymentConfigManifestSha256 = sha256Bytes(deploymentConfigRaw);
  const deploymentConfigDescriptor = deploymentConfigBinding(deploymentConfig, deploymentConfigManifestSha256);
  const { plan } = await createProductionAcceptancePlan({
    catalogPath: DEFAULT_CONTROL_CATALOG_PATH,
    catalogSha256: catalog.sha256,
    imageManifestPath,
    imageManifestSha256,
    deploymentConfigManifestPath,
    deploymentConfigBundlePath,
    deploymentConfigManifestSha256,
    candidateId: candidate.candidateId,
    commitSha: candidate.sourceCommit,
    tag: candidate.signedTag,
    releaseChainId: candidate.chainId,
    deployId: "deploy-production-a",
    environmentId: "production-a",
    environmentDescription: "Dedicated production acceptance environment.",
    region: "cn-east-1",
    plannerId: "planner-release-a",
    createdAtUtc: PLAN_CREATED_AT,
  });
  const planPath = path.join(root, "production-acceptance-plan.json");
  await writeCanonical(planPath, plan);
  const approvalSigners = new Map();
  const trustKeys = [];
  const approvalAuthorities = [];
  for (const role of ["Security", "Data", "Operations", "Release"]) {
    const signer = createTrustedSigner(`approver-${role.toLowerCase()}`);
    approvalSigners.set(role, { ...signer, approverId: `approver-${role.toLowerCase()}` });
    trustKeys.push(signer.trustEntry);
    approvalAuthorities.push({ role, approverId: `approver-${role.toLowerCase()}`, keyId: signer.keyId });
  }
  const collectorSigner = createTrustedSigner("production-browser-collector");
  const observerSigner = createTrustedSigner("production-server-observer");
  trustKeys.push(collectorSigner.trustEntry, observerSigner.trustEntry);
  const hardCutReceiptSigners = {
    acceptance: createTrustedSigner("acceptance-automation"),
    traffic: createTrustedSigner("traffic-automation"),
    closure: createTrustedSigner("closure-automation"),
  };
  trustKeys.push(...Object.values(hardCutReceiptSigners).map((signer) => signer.trustEntry));
  const receiptAuthorities = [{
    scopeId: "production-g11.browser-evidence-collector",
    signerId: collectorSigner.signerId,
    keyId: collectorSigner.keyId,
  }, {
    scopeId: "production-g11.server-observer",
    signerId: observerSigner.signerId,
    keyId: observerSigner.keyId,
  }];
  for (const [scopeId, signer] of [
    ["hard-cut.production-acceptance", hardCutReceiptSigners.acceptance],
    ["hard-cut.traffic-switch", hardCutReceiptSigners.traffic],
    ["hard-cut.rollback-window-closure", hardCutReceiptSigners.closure],
    ...["container", "database", "image", "log", "network", "object-prefix", "secret", "volume"]
      .map((kind) => [`legacy-${kind}`, hardCutReceiptSigners.closure]),
  ]) receiptAuthorities.push({ scopeId, signerId: signer.signerId, keyId: signer.keyId });
  const trustPolicyDocument = {
    schemaVersion: "workbench.production-trust-policy.v1",
    environmentId: plan.payload.binding.environmentId,
    keys: trustKeys,
    approvalAuthorities,
    receiptAuthorities,
  };
  const trustPolicyPath = path.join(root, "trust-policy.json");
  const trustPolicyRaw = Buffer.from(canonicalJsonFile(trustPolicyDocument), "utf8");
  await writeFile(trustPolicyPath, trustPolicyRaw);
  const trustPolicySha256 = sha256Bytes(trustPolicyRaw);
  const trustPolicy = await loadProductionTrustPolicy({
    policyPath: trustPolicyPath,
    expectedSha256: trustPolicySha256,
  });
  const g11 = await createG11Fixture({
    evidenceRoot,
    plan,
    collectorSigner,
    observerSigner,
    hardCutReceiptSigners,
    trustPolicySha256,
  });
  const controls = catalog.document.gates.flatMap((gate) => gate.controls.map((control) => ({
    gateId: gate.gateId,
    control,
  })));
  const rawPaths = new Map();
  const toolAttestations = new Map();
  for (const { gateId, control } of controls) {
    const rawName = `${control.controlId.toLowerCase().replaceAll(".", "-")}.json`;
    const rawPath = path.join(rawDirectory, rawName);
    const observedValue = passingValue(control.threshold);
    const raw = Buffer.from(canonicalJsonFile({ controlId: control.controlId, observedValue }), "utf8");
    await writeFile(rawPath, raw);
    rawPaths.set(control.controlId, rawPath);
    const toolKey = `${control.tool.name}@${control.tool.version}`;
    if (!toolAttestations.has(toolKey)) {
      const toolSlug = control.tool.name.replaceAll(/[^A-Za-z0-9._-]/gu, "-");
      const toolDirectory = path.join(rawDirectory, "tool-attestations");
      await mkdir(toolDirectory, { recursive: true });
      const artifactName = `${toolSlug}-artifact.json`;
      const provenanceName = `${toolSlug}-provenance.json`;
      const artifactRaw = Buffer.from(canonicalJsonFile({
        name: control.tool.name,
        version: control.tool.version,
        sourceCommit: candidate.sourceCommit,
      }), "utf8");
      const provenanceRaw = Buffer.from(canonicalJsonFile({
        builder: "fixture-builder",
        name: control.tool.name,
        version: control.tool.version,
        artifactSha256: sha256Bytes(artifactRaw),
      }), "utf8");
      await writeFile(path.join(toolDirectory, artifactName), artifactRaw);
      await writeFile(path.join(toolDirectory, provenanceName), provenanceRaw);
      toolAttestations.set(toolKey, {
        name: control.tool.name,
        version: control.tool.version,
        artifact: {
          uri: `file:./raw/tool-attestations/${artifactName}`,
          sha256: sha256Bytes(artifactRaw),
        },
        provenance: {
          uri: `file:./raw/tool-attestations/${provenanceName}`,
          sha256: sha256Bytes(provenanceRaw),
        },
        provenanceSubjectSha256: sha256Bytes(artifactRaw),
      });
    }
    const observation = {
      schemaVersion: "workbench.production-control-observation.v1",
      observationId: `observation-${control.controlId.toLowerCase()}`,
      controlId: control.controlId,
      gateId,
      catalog: {
        schemaVersion: catalog.document.schemaVersion,
        sha256: catalog.sha256,
      },
      binding: plan.payload.binding,
      environment: plan.payload.environment,
      executedAtUtc: OBSERVED_AT,
      executor: { id: "auditor-fixture", kind: "auditor" },
      toolVersions: [control.tool],
      toolAttestation: toolAttestations.get(toolKey),
      evidenceLevel: control.evidenceLevel,
      result: {
        executionStatus: "PASS",
        observedValue,
        summary: `${control.controlId} met its protected threshold.`,
      },
      evidence: control.controlId.startsWith("G11.") && control.controlId !== "G11.FIGMA.SCOPE"
        ? structuredClone(g11.observationEvidence)
        : [{
          kind: "probe",
          uri: `file:./raw/${rawName}`,
          sha256: sha256Bytes(raw),
        }],
      retryRecords: [],
    };
    await writeCanonical(path.join(observationsDirectory, `${control.controlId}.json`), observation);
  }
  return {
    root,
    evidenceRoot,
    observationsDirectory,
    rawDirectory,
    rawPaths,
    catalog,
    candidate,
    imageManifestPath,
    imageManifestSha256,
    deploymentConfigManifestPath,
    deploymentConfigBundlePath,
    deploymentConfigManifestSha256,
    deploymentConfig: deploymentConfigDescriptor,
    plan,
    planPath,
    approvalSigners,
    collectorSigner,
    observerSigner,
    hardCutReceiptSigners,
    trustPolicy,
    trustPolicyDocument,
    trustPolicyPath,
    trustPolicySha256,
    g11,
    controls,
    collectionRoot: path.join(root, "collection"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createG11Fixture({ evidenceRoot, plan, collectorSigner, observerSigner, trustPolicySha256 }) {
  const root = path.join(evidenceRoot, "raw", "g11");
  await mkdir(root, { recursive: true });
  const created = await createDiagnosticG11Fixture({
    binding: plan.payload.binding,
    environment: plan.payload.environment,
    plan,
    collectorSigner,
    observerSigner,
    trustPolicySha256,
    flowChecks: passingG11FlowChecks(),
    async addArtifact(relativePath, bytes, kind) {
      const artifactPath = path.join(root, relativePath);
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, bytes);
      return {
        kind,
        uri: `file:./raw/g11/${relativePath}`,
        sha256: sha256Bytes(bytes),
      };
    },
  });
  const manifestPath = path.join(root, "manifest.json");
  return {
    ...created,
    manifestPath,
  };
}

function passingG11FlowChecks() {
  return {
    "account-project": {
      accountCreated: true,
      loginCompleted: true,
      invitationAccepted: true,
      workspaceOpened: true,
      projectOpened: true,
      membershipRolesEnforced: true,
      revokedAccessDenied: true,
      expiredInvitationDenied: true,
      unauthorizedPathsClosed: true,
    },
    prd: {
      requestAccepted: true,
      loadingCompositionRendered: true,
      activePanelContextRendered: true,
      stageSequenceContinuous: true,
      readyArtifactPersisted: true,
      checksumVerified: true,
    },
    "mixed-rejection": {
      problemStatus: 422,
      queuePublishCount: 0,
      runCount: 0,
      runtimeAttemptCount: 0,
      artifactVersionCount: 0,
      providerInvocationCount: 0,
      sseEventCount: 0,
    },
    "prototype-after-prd": {
      startedAfterPrd: true,
      nullGapPrdMotionAbsent: true,
      thinkingGapPrdMotionAbsent: true,
      prototypeMotionRendered: true,
      readyArtifactPersisted: true,
    },
    "refresh-reconnect": {
      reconnectCursorAdvanced: true,
      sequenceContinuous: true,
      stateRestored: true,
      artifactPersisted: true,
    },
    "preview-import-export": {
      fileImportCompleted: true,
      knowledgeImportCompleted: true,
      exportCompleted: true,
      previewLoaded: true,
      explicitPublicationConfirmation: true,
      failureRecoveryPassed: true,
      checksumVerified: true,
    },
    "run-canvas-sse-artifact": {
      runCompleted: true,
      approvalPassed: true,
      failurePassed: true,
      cancelPassed: true,
      retryPassed: true,
      canvasGatewayUsed: true,
      prototypePatchStableNodeIds: true,
      sseDurable: true,
      sequenceContinuous: true,
      authorizationPassed: true,
      idempotencyPreserved: true,
      artifactPersisted: true,
      checksumVerified: true,
      revisionAdvanced: true,
    },
    "accessibility-preview-security": {
      keyboardPassed: true,
      focusPassed: true,
      accessibleNamesPassed: true,
      contrastPassed: true,
      reducedMotionPassed: true,
      previewIndependentOrigin: true,
      previewCredentialless: true,
      previewAllowSameOriginAbsent: true,
      previewNoReferrer: true,
      previewCapabilityValidated: true,
      previewRpcPassed: true,
      previewTimeoutProtected: true,
      previewGenerationProtected: true,
    },
    "long-run-7686-plus": {
      minimumEventCount: 7_686,
      observedEventCount: 7_686,
      crossedBoundary: true,
      terminalStateCorrect: true,
      retryRecoveryPassed: true,
    },
    "knowledge-null-valid": {
      nullReleaseGrantAbsent: true,
      nullReleaseSecretAbsent: true,
      nullReleaseCatalogAbsent: true,
      validPinnedReleaseVisible: true,
      validPinnedReleaseInvocationPassed: true,
      concurrentScopeIsolated: true,
      secretsNotPersisted: true,
    },
    "provider-state-integrity": {
      textComplete: true,
      effectsComplete: true,
      draftComplete: true,
      artifactsComplete: true,
      duplicateTextCount: 0,
      lostTextCount: 0,
      duplicateEffectCount: 0,
      lostEffectCount: 0,
      duplicateDraftCount: 0,
      lostDraftCount: 0,
      duplicateArtifactCount: 0,
      lostArtifactCount: 0,
    },
  };
}

async function rewriteG11Manifest(manifestPath, manifest) {
  const raw = Buffer.from(canonicalJsonFile(manifest), "utf8");
  await writeFile(manifestPath, raw);
  return { uri: "file:./raw/g11/manifest.json", sha256: sha256Bytes(raw) };
}

async function loadG11Fixture(fixture, manifest) {
  const reference = await rewriteG11Manifest(fixture.g11.manifestPath, manifest);
  return loadProductionG11RealStackManifest({
    reference,
    evidenceRoot: fixture.evidenceRoot,
    plan: fixture.plan,
    executedAtUtc: OBSERVED_AT,
    trustPolicy: fixture.trustPolicy,
  });
}

function g11ArtifactPath(evidenceRoot, reference) {
  assert.match(reference.uri, /^file:\.\/raw\/g11\//u);
  return path.join(evidenceRoot, reference.uri.slice("file:./".length));
}

async function rewriteG11CellReceipt(evidenceRoot, cell, mutate) {
  const receiptPath = g11ArtifactPath(evidenceRoot, cell.receipt);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(receipt);
  const raw = Buffer.from(canonicalJsonFile(receipt), "utf8");
  await writeFile(receiptPath, raw);
  cell.receipt.sha256 = sha256Bytes(raw);
}

async function rewriteG11CellTrace(evidenceRoot, cell, options) {
  const receiptPath = g11ArtifactPath(evidenceRoot, cell.receipt);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const archive = createDiagnosticG11SanitizedTrace({
    traceId: receipt.captureId,
    browser: receipt.browser.name,
    browserVersion: receipt.browser.version,
    viewport: receipt.viewport,
    motion: receipt.motion,
    startedAtUtc: receipt.traceStartedAtUtc,
    finishedAtUtc: receipt.traceFinishedAtUtc,
    nativeTraceSha256: options.nativeTraceSha256 ?? receipt.nativeTraceSha256,
    scenarioId: `visual-${receipt.state}`,
    scenarioBinding: receipt.scenarioBinding,
    scenarioPlan: productionG11ScenarioPlan({
      scenarioId: `visual-${receipt.state}`,
      scenarioBinding: receipt.scenarioBinding,
    }),
    originPolicySha256: productionG11OriginPolicySha256(receipt.deployment),
    mutateMetadata: options.mutateMetadata,
    mutateCalls: options.mutateCalls,
    mutateNetwork: options.mutateNetwork,
    extraEntries: options.extraEntries,
  });
  await writeFile(g11ArtifactPath(evidenceRoot, cell.trace), archive.bytes);
  cell.trace.sha256 = sha256Bytes(archive.bytes);
  receipt.trace = cell.trace;
  const receiptBytes = Buffer.from(canonicalJsonFile(receipt), "utf8");
  await writeFile(receiptPath, receiptBytes);
  cell.receipt.sha256 = sha256Bytes(receiptBytes);
}

async function rewriteG11FlowReceipt(evidenceRoot, flow, mutate) {
  const reference = flow.evidence.find(({ kind }) => kind === "browser-flow-receipt");
  const receiptPath = g11ArtifactPath(evidenceRoot, reference);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  mutate(receipt);
  const raw = Buffer.from(canonicalJsonFile(receipt), "utf8");
  await writeFile(receiptPath, raw);
  reference.sha256 = sha256Bytes(raw);
}

async function rewriteG11FlowTrace(evidenceRoot, flow, selectStepIds, mutateMetadata) {
  const receiptReference = flow.evidence.find(({ kind }) => kind === "browser-flow-receipt");
  const receiptPath = g11ArtifactPath(evidenceRoot, receiptReference);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const coverage = receipt.coverage[0];
  const traceReference = flow.evidence.find(({ uri }) => uri === coverage.trace.uri);
  const viewport = {
    id: coverage.viewport,
    width: Number(coverage.viewport.split("x")[0]),
    height: Number(coverage.viewport.split("x")[1]),
  };
  const archive = createDiagnosticG11SanitizedTrace({
    traceId: coverage.traceId,
    browser: coverage.browser,
    browserVersion: coverage.browserVersion,
    viewport,
    motion: coverage.motion,
    startedAtUtc: coverage.startedAtUtc,
    finishedAtUtc: coverage.finishedAtUtc,
    nativeTraceSha256: coverage.nativeTraceSha256,
    scenarioId: receipt.flowId,
    scenarioBinding: receipt.scenarioBinding,
    scenarioPlan: productionG11ScenarioPlan({
      scenarioId: receipt.flowId,
      scenarioBinding: receipt.scenarioBinding,
    }),
    originPolicySha256: productionG11OriginPolicySha256(receipt.deployment),
    mutateMetadata,
    mutateCalls: (calls) => {
      const selected = new Set(selectStepIds(coverage));
      calls.calls = calls.calls.filter(({ stepId }) => selected.has(stepId));
    },
  });
  await writeFile(g11ArtifactPath(evidenceRoot, traceReference), archive.bytes);
  traceReference.sha256 = sha256Bytes(archive.bytes);
  coverage.trace = traceReference;
  const raw = Buffer.from(canonicalJsonFile(receipt), "utf8");
  await writeFile(receiptPath, raw);
  receiptReference.sha256 = sha256Bytes(raw);
}

async function resyncG11ObserverReceipt(fixture, flow) {
  const browserReference = flow.evidence.find(({ kind }) => kind === "browser-flow-receipt");
  const observerReference = flow.evidence.find(({ kind }) => kind === "server-observer-receipt");
  const browserReceipt = JSON.parse(await readFile(g11ArtifactPath(fixture.evidenceRoot, browserReference), "utf8"));
  const observerPath = g11ArtifactPath(fixture.evidenceRoot, observerReference);
  const observerReceipt = JSON.parse(await readFile(observerPath, "utf8"));
  observerReceipt.coverage = browserReceipt.coverage;
  observerReceipt.signature.value = sign(
    null,
    Buffer.from(canonicalJson(productionG11ServerObserverReceiptPayload(observerReceipt)), "utf8"),
    fixture.observerSigner.privateKey,
  ).toString("base64url");
  const raw = Buffer.from(canonicalJsonFile(observerReceipt), "utf8");
  await writeFile(observerPath, raw);
  observerReference.sha256 = sha256Bytes(raw);
}

async function createRunnerToolAttestation(fixture) {
  const directory = path.join(fixture.rawDirectory, "runner-attestation");
  await mkdir(directory, { recursive: true });
  const runnerRaw = await readFile(path.join(repoRoot, "scripts/production-acceptance/run-control.mjs"));
  const runnerSha256 = sha256Bytes(runnerRaw);
  const provenanceRaw = Buffer.from(canonicalJsonFile({
    name: "workbench-production-control-runner",
    subjectSha256: runnerSha256,
  }), "utf8");
  await writeFile(path.join(directory, "run-control.mjs"), runnerRaw);
  await writeFile(path.join(directory, "provenance.json"), provenanceRaw);
  const tool = fixture.catalog.byControl.get(PRODUCTION_G11_REAL_STACK_CONTROL_IDS[0]).control.tool;
  return {
    name: tool.name,
    version: tool.version,
    artifact: {
      uri: "file:./raw/runner-attestation/run-control.mjs",
      sha256: runnerSha256,
    },
    provenance: {
      uri: "file:./raw/runner-attestation/provenance.json",
      sha256: sha256Bytes(provenanceRaw),
    },
    provenanceSubjectSha256: runnerSha256,
  };
}

function productionControlResult({
  controlId,
  execution,
  executionEvidence,
  observedValue,
  toolAttestation,
}) {
  return {
    schemaVersion: "workbench.production-control-result.v1",
    controlId,
    executedAtUtc: OBSERVED_AT,
    executor: { id: "auditor-fixture", kind: "auditor" },
    observedValue,
    summary: "This untrusted summary and observed value must not control G11.",
    conditionalResult: null,
    execution: {
      kind: execution.kind,
      source: execution.kind === "command"
        ? { argv: [...execution.argv], evidenceKind: execution.evidenceKind }
        : { path: execution.path, section: execution.section },
      evidence: structuredClone(executionEvidence),
    },
    toolAttestation: structuredClone(toolAttestation),
    evidence: [],
    retryRecords: [],
  };
}

async function collectPrepared(fixture, outputName) {
  const outputRoot = path.join(fixture.root, outputName);
  const result = await collectProductionAcceptanceEvidence({
    planPath: fixture.planPath,
    observationsDirectory: fixture.observationsDirectory,
    evidenceRoot: fixture.evidenceRoot,
    trustPolicyPath: fixture.trustPolicyPath,
    expectedTrustPolicySha256: sha256Bytes(await readFile(fixture.trustPolicyPath)),
    outputRoot,
    collectedAtUtc: COLLECTED_AT,
  });
  fixture.collectionRoot = outputRoot;
  fixture.collectionResult = result;
  return result;
}

async function forgeFailingObservationAsPass(fixture) {
  const selected = fixture.controls.find(({ control }) => control.threshold.kind === "boolean");
  const observationRelative = `observations/${selected.control.controlId}.json`;
  const observationPath = path.join(fixture.collectionRoot, ...observationRelative.split("/"));
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  observation.result.observedValue = !selected.control.threshold.expected;
  const observationRaw = Buffer.from(canonicalJsonFile(observation), "utf8");
  await writeFile(observationPath, observationRaw);

  const ledgerPath = path.join(fixture.collectionRoot, `gates/${selected.gateId.toLowerCase()}.json`);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const entry = ledger.payload.entries.find((candidate) => candidate.entryId === selected.control.controlId);
  entry.evidence.find((reference) => reference.uri === `file:./${observationRelative}`).sha256 = sha256Bytes(observationRaw);
  ledger.payloadSha256 = sha256Canonical({ schemaVersion: ledger.schemaVersion, payload: ledger.payload });
  const ledgerRaw = Buffer.from(canonicalJsonFile(ledger), "utf8");
  await writeFile(ledgerPath, ledgerRaw);

  const collectionPath = path.join(fixture.collectionRoot, "collection.json");
  const collection = JSON.parse(await readFile(collectionPath, "utf8"));
  collection.payload.gates.find((gate) => gate.gateId === selected.gateId).ledger.sha256 = sha256Bytes(ledgerRaw);
  collection.payloadSha256 = sha256Canonical({ schemaVersion: collection.schemaVersion, payload: collection.payload });
  await writeCanonical(collectionPath, collection);
}

function productionImageManifestFixture(candidate) {
  const immutable = () => ({
    sha256: "f".repeat(64),
    uri: `urn:sha256:${"f".repeat(64)}`,
  });
  const images = loadProductionImageInventory().candidateImages.map((definition, index) => {
    const digest = `sha256:${String(index + 1).padStart(64, "0")}`;
    return {
      id: definition.id,
      imageRef: `registry.example.test/workbench/${definition.id}@${digest}`,
      digest,
      sourceCommit: candidate.sourceCommit,
      buildConfiguration: createProductionBuildConfiguration({
        id: definition.id,
        sourceCommit: candidate.sourceCommit,
        dockerfile: definition.dockerfile,
        target: definition.target,
        buildArgsSource: "",
      }),
      sbom: immutable(),
      sbomAttestation: immutable(),
      provenance: immutable(),
      signature: { ...immutable(), verification: immutable(), verified: true },
      vulnerabilityReport: { ...immutable(), status: "PASS", critical: 0, high: 0 },
    };
  });
  return {
    schemaVersion: 1,
    candidate: {
      sourceCommit: candidate.sourceCommit,
      releaseChainId: candidate.chainId,
    },
    images,
  };
}

function passingValue(threshold) {
  if (threshold.kind === "boolean") return threshold.expected;
  if (threshold.operator === "eq" || threshold.operator === "lte" || threshold.operator === "gte") return threshold.expected;
  if (threshold.operator === "lt") return threshold.expected - 1;
  if (threshold.operator === "gt") return threshold.expected + 1;
  throw new Error(`unsupported threshold operator ${threshold.operator}`);
}

function catalogEntry(gateId, control) {
  return {
    entryId: control.controlId,
    gateId,
    controlObjective: control.controlObjective,
    prerequisites: control.prerequisites,
    procedure: control.procedure,
    expectedObservation: control.expectedObservation,
    threshold: control.threshold,
    evidenceLevel: control.evidenceLevel,
    relatedFindingsOrDecisions: control.relatedFindingsOrDecisions,
    toolVersions: [control.tool],
  };
}

async function writeCanonical(filePath, value) {
  await writeFile(filePath, canonicalJsonFile(value), "utf8");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertContractFailure(action, pattern) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof ProductionAcceptanceContractError, true, error?.stack ?? String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

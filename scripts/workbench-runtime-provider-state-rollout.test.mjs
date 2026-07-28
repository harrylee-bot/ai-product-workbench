import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_PROVIDER_STATE_OBSERVATION_SCHEMA,
  executeRolloutOperation,
  parseRolloutArguments,
  prepareRolloutOperation,
  rolloutPlanDocument,
  validateRolloutObservation,
  verifyRolloutReceiptChain,
} from "./workbench-runtime-provider-state-rollout.mjs";

const candidateSha = "a".repeat(40);
const evidenceSha = "b".repeat(64);
const inventoryDigest = "c".repeat(64);
const workerImageDigest = `sha256:${"d".repeat(64)}`;

test("parses an explicit candidate-bound rollout operation", () => {
  assert.deepEqual(parseRolloutArguments([
    "--execute",
    "--phase", "shadow",
    "--candidate-sha", candidateSha,
    "--environment-id", "staging-cn-1",
    "--environment-kind", "staging",
    "--observation", "/evidence/shadow.json",
    "--receipts-dir", "/evidence/receipts",
  ]), {
    execute: true,
    help: false,
    phase: "shadow",
    candidateSha,
    environmentId: "staging-cn-1",
    environmentKind: "staging",
    observationPath: "/evidence/shadow.json",
    receiptsDirectory: "/evidence/receipts",
  });
  assert.throws(() => parseRolloutArguments(["--phase", "shadow"]), /--candidate-sha is required/u);
  assert.throws(() => parseRolloutArguments(["--unknown"]), /unknown Runtime provider-state rollout argument/u);
});

test("requires complete backfill coverage before a receipt can be prepared", () => {
  const observation = observationFor("backfill");
  assert.doesNotThrow(() => validateRolloutObservation(observation, bindingFor("backfill")));
  assert.throws(
    () => validateRolloutObservation({
      ...observation,
      metrics: { ...observation.metrics, missing: 1, built: 0, verified: 0 },
    }, bindingFor("backfill")),
    /100% verified/u,
  );
  assert.throws(
    () => validateRolloutObservation({
      ...observation,
      metrics: { ...observation.metrics, rolloutBlocked: true },
    }, bindingFor("backfill")),
    /rolloutBlocked/u,
  );
});

test("fails closed on shadow mismatches, lag, P2028, or an empty observation", () => {
  const observation = observationFor("shadow");
  for (const [field, value] of [
    ["shadowMismatches", 1],
    ["projectionInvariantErrors", 1],
    ["projectionLag", 1],
    ["providerStateP2028", 1],
    ["observedEvents", 0],
  ]) {
    assert.throws(
      () => validateRolloutObservation({
        ...observation,
        metrics: { ...observation.metrics, [field]: value },
      }, bindingFor("shadow")),
      /blocking Runtime invariant|has no events/u,
    );
  }
});

test("requires immutable image binding and full worker readiness after shadow", () => {
  const canary = observationFor("canary");
  assert.doesNotThrow(() => validateRolloutObservation(canary, bindingFor("canary")));
  assert.throws(
    () => validateRolloutObservation({ ...canary, workerImageDigest: "worker:latest" }, bindingFor("canary")),
    /immutable worker and inventory digests/u,
  );
  assert.throws(
    () => validateRolloutObservation({
      ...canary,
      metrics: { ...canary.metrics, readyWorkers: 0 },
    }, bindingFor("canary")),
    /worker readiness is incomplete/u,
  );

  const full = observationFor("full");
  assert.throws(
    () => validateRolloutObservation({
      ...full,
      metrics: { ...full.metrics, legacyReadTraffic: 1 },
    }, bindingFor("full")),
    /legacy workers or traffic/u,
  );
});

test("rejects sensitive evidence paths and unexpected observation fields", () => {
  const observation = observationFor("shadow");
  assert.throws(
    () => validateRolloutObservation({
      ...observation,
      evidence: [{ kind: "metrics", path: "captures/database-url.json", sha256: evidenceSha }],
    }, bindingFor("shadow")),
    /invalid or sensitive/u,
  );
  assert.throws(
    () => validateRolloutObservation({ ...observation, prompt: "must never enter a receipt" }, bindingFor("shadow")),
    /fields are invalid/u,
  );
});

test("writes an immutable chained receipt sequence and verifies it end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-rollout-"));
  const receiptsDirectory = path.join(root, "receipts");
  let terminalSha = null;
  for (const phase of ["backfill", "shadow", "canary", "cutover", "full"]) {
    const observationPath = path.join(root, `${phase}-observation.json`);
    await writeFile(observationPath, `${JSON.stringify(observationFor(phase))}\n`);
    const operation = await prepareRolloutOperation(optionsFor({ phase, observationPath, receiptsDirectory }), {
      repoRoot: process.cwd(),
    });
    const plan = rolloutPlanDocument(operation);
    assert.equal(plan.mode, "PLAN");
    assert.equal(plan.executionRequested, true);
    assert.equal(plan.previousReceiptSha256, terminalSha);
    const result = await executeRolloutOperation(operation, {
      now: () => new Date(`2026-07-2${phaseIndex(phase) + 1}T00:00:00.000Z`),
    });
    assert.equal(result.created, true);
    terminalSha = result.receiptSha256;
  }

  const chain = await verifyRolloutReceiptChain({
    candidateSha,
    environmentId: "isolated-rollout",
    environmentKind: "isolated",
    receiptsDirectory,
  });
  assert.equal(chain.receipts.length, 5);
  assert.equal(chain.completeThrough, "full");
  assert.equal(chain.terminalReceiptSha256, terminalSha);
  assert.deepEqual(chain.receipts.map((entry) => entry.phase), ["backfill", "shadow", "canary", "cutover", "full"]);
});

test("replays an identical phase idempotently and rejects conflicting evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-rollout-replay-"));
  const receiptsDirectory = path.join(root, "receipts");
  const observationPath = path.join(root, "backfill.json");
  await writeFile(observationPath, `${JSON.stringify(observationFor("backfill"))}\n`);
  const operation = await prepareRolloutOperation(optionsFor({
    phase: "backfill",
    observationPath,
    receiptsDirectory,
  }));
  const first = await executeRolloutOperation(operation, { now: () => new Date("2026-07-21T00:00:00.000Z") });
  const replay = await executeRolloutOperation(operation, { now: () => new Date("2026-07-22T00:00:00.000Z") });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.receiptSha256, first.receiptSha256);

  const conflictingPath = path.join(root, "backfill-conflict.json");
  const conflicting = observationFor("backfill");
  conflicting.finishedAtUtc = "2026-07-20T00:20:00.000Z";
  await writeFile(conflictingPath, `${JSON.stringify(conflicting)}\n`);
  const conflictingOperation = await prepareRolloutOperation(optionsFor({
    phase: "backfill",
    observationPath: conflictingPath,
    receiptsDirectory,
  }));
  await assert.rejects(() => executeRolloutOperation(conflictingOperation), /immutable receipt already exists/u);
});

test("never overwrites a receipt that appears during atomic publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-rollout-race-"));
  const receiptsDirectory = path.join(root, "receipts");
  const observationPath = path.join(root, "backfill.json");
  await writeFile(observationPath, `${JSON.stringify(observationFor("backfill"))}\n`);
  const operation = await prepareRolloutOperation(optionsFor({
    phase: "backfill",
    observationPath,
    receiptsDirectory,
  }));
  const competingReceipt = Buffer.from("competing immutable receipt\n");

  await assert.rejects(
    () => executeRolloutOperation(operation, {
      beforePublish: async () => {
        await writeFile(operation.outputPath, competingReceipt, { flag: "wx", mode: 0o440 });
      },
    }),
    /receipt creation raced/u,
  );

  assert.deepEqual(await readFile(operation.outputPath), competingReceipt);
  assert.deepEqual(
    (await readdir(receiptsDirectory)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("detects receipt tampering and refuses out-of-order phases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-rollout-tamper-"));
  const receiptsDirectory = path.join(root, "receipts");
  const shadowPath = path.join(root, "shadow.json");
  await writeFile(shadowPath, `${JSON.stringify(observationFor("shadow"))}\n`);
  await assert.rejects(
    () => prepareRolloutOperation(optionsFor({ phase: "shadow", observationPath: shadowPath, receiptsDirectory })),
    /backfill receipt is required/u,
  );

  const backfillPath = path.join(root, "backfill.json");
  await writeFile(backfillPath, `${JSON.stringify(observationFor("backfill"))}\n`);
  const operation = await prepareRolloutOperation(optionsFor({ phase: "backfill", observationPath: backfillPath, receiptsDirectory }));
  await executeRolloutOperation(operation);
  const receiptPath = path.join(receiptsDirectory, "01-backfill.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.payload.observation.metrics.verified = 0;
  await chmod(receiptPath, 0o600);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(
    () => verifyRolloutReceiptChain({
      candidateSha,
      environmentId: "isolated-rollout",
      environmentKind: "isolated",
      receiptsDirectory,
      throughPhase: "backfill",
    }),
    /must be read-only|payload hash is invalid/u,
  );
});

test("requires staging and production receipts outside the repository", async () => {
  const root = await mkdtemp(path.join(process.cwd(), "output", "runtime-rollout-test-"));
  const observationPath = path.join(root, "backfill.json");
  await writeFile(observationPath, `${JSON.stringify(observationFor("backfill", {
    environmentId: "staging-cn-1",
    environmentKind: "staging",
  }))}\n`);
  await assert.rejects(
    () => prepareRolloutOperation({
      ...optionsFor({ phase: "backfill", observationPath, receiptsDirectory: path.join(root, "receipts") }),
      environmentId: "staging-cn-1",
      environmentKind: "staging",
    }),
    /outside the repository/u,
  );
});

function observationFor(phase, {
  environmentId = "isolated-rollout",
  environmentKind = "isolated",
} = {}) {
  const base = {
    schemaVersion: RUNTIME_PROVIDER_STATE_OBSERVATION_SCHEMA,
    phase,
    candidateSha,
    environment: { id: environmentId, kind: environmentKind },
    projectionVersion: 2,
    providerStateMode: phase === "backfill"
      ? "legacy-read"
      : phase === "shadow" || phase === "canary"
        ? "shadow-verify"
        : "projection-required",
    startedAtUtc: "2026-07-20T00:00:00.000Z",
    finishedAtUtc: "2026-07-20T00:10:00.000Z",
    approvalReference: "CHG-2026-0720",
    workerImageDigest: phase === "backfill" || phase === "shadow" ? null : workerImageDigest,
    inventoryDigest: phase === "backfill" || phase === "shadow" ? null : inventoryDigest,
    metrics: metricsFor(phase),
    evidence: [{ kind: "metrics", path: `runtime/${phase}-metrics.json`, sha256: evidenceSha }],
  };
  return base;
}

function metricsFor(phase) {
  if (phase === "backfill") {
    return {
      totalAttempts: 1,
      expectedProjections: 1,
      built: 1,
      verified: 1,
      missing: 0,
      conflicts: 0,
      lagging: 0,
      versionMismatch: 0,
      hashMismatch: 0,
      activeMissing: 0,
      terminalMissing: 0,
      rolloutBlocked: false,
    };
  }
  const common = {
    observedEvents: 100,
    projectionInvariantErrors: 0,
    projectionLag: 0,
    providerStateP2028: 0,
  };
  if (phase === "shadow") return { ...common, shadowMismatches: 0 };
  if (phase === "canary") {
    return {
      desiredWorkers: 1,
      readyWorkers: 1,
      ...common,
      shadowMismatches: 0,
      terminalRunDrift: 0,
    };
  }
  if (phase === "cutover") {
    return {
      desiredWorkers: 1,
      readyWorkers: 1,
      ...common,
      terminalRunDrift: 0,
    };
  }
  return {
    desiredWorkers: 3,
    readyWorkers: 3,
    legacyWorkerCount: 0,
    legacyReadTraffic: 0,
    ...common,
    terminalRunDrift: 0,
  };
}

function bindingFor(phase) {
  return {
    phase,
    candidateSha,
    environmentId: "isolated-rollout",
    environmentKind: "isolated",
  };
}

function optionsFor({ phase, observationPath, receiptsDirectory }) {
  return {
    execute: true,
    help: false,
    phase,
    candidateSha,
    environmentId: "isolated-rollout",
    environmentKind: "isolated",
    observationPath,
    receiptsDirectory,
  };
}

function phaseIndex(phase) {
  return ["backfill", "shadow", "canary", "cutover", "full"].indexOf(phase);
}

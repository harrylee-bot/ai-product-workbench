import path from "node:path";

import { canonicalJson, sha256Bytes } from "../evidence-ledger.mjs";
import { ProductionAcceptanceContractError } from "./catalog.mjs";
import {
  assertObservationMatchesPlanAndControl,
  loadProductionControlObservation,
} from "./collect.mjs";

export async function replayProductionControlObservation({
  entry,
  root,
  plan,
  catalog,
  collectedAtUtc,
} = {}) {
  const expected = catalog?.byControl?.get(entry?.entryId);
  if (!expected) {
    throw new ProductionAcceptanceContractError([
      `${entry?.entryId ?? "unknown"} is not present in the protected control catalog`,
    ]);
  }
  const observationPath = `observations/${entry.entryId}.json`;
  const loaded = await loadProductionControlObservation({
    sourcePath: resolveWithin(root, observationPath),
  });
  assertObservationMatchesPlanAndControl({
    observation: loaded.observation,
    expected,
    plan,
    catalog,
    collectedTime: new Date(collectedAtUtc),
  });
  assertLedgerEntryMatchesObservation({
    entry,
    observation: loaded.observation,
    observationPath,
    observationSha256: sha256Bytes(loaded.raw),
  });
  return Object.freeze({
    observationPath,
    observationSha256: sha256Bytes(loaded.raw),
    observation: loaded.observation,
  });
}

export function assertLedgerEntryMatchesObservation({
  entry,
  observation,
  observationPath,
  observationSha256,
}) {
  const findings = [];
  for (const [field, expected] of [
    ["executionStatus", observation.result.executionStatus],
    ["evidenceLevel", observation.evidenceLevel],
    ["executedAtUtc", observation.executedAtUtc],
    ["executor", observation.executor],
    ["toolVersions", observation.toolVersions],
    ["environment", observation.environment],
    ["binding", observation.binding],
    ["findingStatus", "CONFIRMED"],
  ]) {
    if (canonicalJson(entry[field]) !== canonicalJson(expected)) {
      findings.push(`${entry.entryId} ledger ${field} differs from its observation`);
    }
  }
  const expectedEvidence = [
    { uri: `file:./${observationPath}`, sha256: observationSha256 },
    observation.toolAttestation.artifact,
    observation.toolAttestation.provenance,
    ...observation.evidence.map(({ uri, sha256 }) => ({ uri, sha256 })),
  ].sort((left, right) => compareStrings(left.uri, right.uri));
  if (canonicalJson(entry.evidence) !== canonicalJson(expectedEvidence)) {
    findings.push(`${entry.entryId} ledger evidence differs from its observation`);
  }
  const expectedRetries = structuredClone(observation.retryRecords)
    .sort((left, right) => left.attempt - right.attempt)
    .map((retry) => ({
      ...retry,
      evidence: retry.evidence.sort((left, right) => compareStrings(left.uri, right.uri)),
    }));
  if (canonicalJson(entry.retryRecords) !== canonicalJson(expectedRetries)) {
    findings.push(`${entry.entryId} ledger retryRecords differ from its observation`);
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return true;
}

function resolveWithin(root, relativePath) {
  const resolvedRoot = path.resolve(root ?? "");
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProductionAcceptanceContractError([`${relativePath} escapes the observation root`]);
  }
  return resolved;
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Bytes } from "../evidence-ledger.mjs";
import {
  CONTROL_EXECUTION_REGISTRY,
  PRODUCTION_CONTROL_RUNNER_NAME,
  PRODUCTION_CONTROL_RUNNER_PATH,
  executionForControl,
} from "./control-execution-registry.mjs";
import { createStrictAjv2020 } from "./schema.mjs";

export const CONTROL_CATALOG_SCHEMA_VERSION = "workbench.production-acceptance-control-catalog.v1";
export const REQUIRED_PRODUCTION_GATES = Object.freeze(["G5", "G6", "G7", "G8", "G9", "G10", "G11"]);

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsRoot, "../..");
export const DEFAULT_CONTROL_CATALOG_PATH = path.join(
  repoRoot,
  "docs/evidence/governance/production-acceptance-control-catalog.v1.json",
);
export const CONTROL_CATALOG_PACKAGE_PATH = "governance/production-acceptance-control-catalog.v1.json";
const schemaPath = path.join(
  repoRoot,
  "docs/evidence/governance/production-acceptance-control-catalog.schema.json",
);
const CAPACITY_THRESHOLDS = Object.freeze(new Map([
  ["G10.CAPACITY.ACTIVE_RUNS", { kind: "number", operator: "gte", expected: 100, unit: "simultaneous-active-runs" }],
  ["G10.CAPACITY.BATCH_SIZE", { kind: "number", operator: "eq", expected: 100, unit: "run-ids-per-query" }],
  ["G10.CAPACITY.CANCEL_LATENCY", { kind: "number", operator: "lte", expected: 10_000, unit: "milliseconds" }],
  ["G10.CAPACITY.POLLER_QPS_PER_REPLICA", { kind: "number", operator: "lte", expected: 4, unit: "queries-per-second-per-replica" }],
  ["G10.CAPACITY.RECOVERY_TIME", { kind: "number", operator: "lte", expected: 60_000, unit: "milliseconds" }],
]));
export const PROPOSED_CAPACITY_PROFILE = Object.freeze({
  profileId: "workbench-production-capacity-v1",
  status: "proposed-baseline",
  activeRuns: 100,
  workerReplicas: 10,
  runtimeConcurrencyPerReplica: 10,
  cancellationQueryBatchSize: 100,
  pollIntervalMs: 1_000,
  maxPollerQpsPerReplica: 4,
  cancelP95Ms: 10_000,
  recoveryMs: 60_000,
});

let schemaValidatorPromise;

export class ProductionAcceptanceContractError extends Error {
  constructor(findings) {
    const input = Array.isArray(findings) ? findings : [findings];
    const bounded = [];
    const seen = new Set();
    for (const finding of input) {
      const normalizedFinding = String(finding)
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .slice(0, 1_024);
      if (seen.has(normalizedFinding)) continue;
      seen.add(normalizedFinding);
      if (bounded.length < 255) bounded.push(normalizedFinding);
    }
    if (seen.size > bounded.length) bounded.push("production acceptance findings were truncated");
    const normalized = bounded.sort();
    super(`Production acceptance contract failed (${normalized.length} finding${normalized.length === 1 ? "" : "s"}):\n${normalized.map((finding) => `- ${finding}`).join("\n")}`);
    this.name = "ProductionAcceptanceContractError";
    this.findings = normalized;
  }
}

export async function loadProductionAcceptanceControlCatalog({
  catalogPath = DEFAULT_CONTROL_CATALOG_PATH,
  expectedSha256,
} = {}) {
  const resolvedPath = path.resolve(catalogPath);
  const raw = await readFile(resolvedPath);
  const sha256 = sha256Bytes(raw);
  const findings = [];
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
    findings.push(`control catalog SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
  let document;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    findings.push(`control catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document) {
    const validate = await catalogSchemaValidator();
    if (!validate(document)) {
      for (const error of validate.errors ?? []) {
        findings.push(`control catalog${error.instancePath || "/"} ${error.message}`);
      }
    }
    await validateCatalogSemantics(document, findings);
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  document = normalizeCatalogDocument(document);
  const byGate = new Map(document.gates.map((gate) => [gate.gateId, gate]));
  const byControl = new Map(document.gates.flatMap((gate) => (
    gate.controls.map((control) => [control.controlId, { gateId: gate.gateId, control }])
  )));
  return Object.freeze({
    path: resolvedPath,
    raw,
    sha256,
    document,
    byGate,
    byControl,
  });
}

export function assertGateEntriesMatchCatalog({ gateId, entries, catalog }) {
  const findings = [];
  const gate = catalog?.byGate?.get(gateId);
  if (!gate) findings.push(`control catalog does not define ${gateId}`);
  if (!Array.isArray(entries)) findings.push(`${gateId} ledger entries must be an array`);
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const expected = gate.controls;
  const expectedIds = expected.map((control) => control.controlId);
  const actualIds = entries.map((entry) => entry?.entryId);
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    findings.push(`${gateId} ledger entry IDs must exactly match the protected control catalog`);
  }
  for (let index = 0; index < Math.min(expected.length, entries.length); index += 1) {
    const control = expected[index];
    const entry = entries[index];
    const label = `${gateId}/${control.controlId}`;
    if (entry?.gateId !== gateId) findings.push(`${label} ledger gateId mismatch`);
    for (const [field, expectedValue] of [
      ["controlObjective", control.controlObjective],
      ["prerequisites", control.prerequisites],
      ["procedure", control.procedure],
      ["expectedObservation", control.expectedObservation],
      ["threshold", control.threshold],
      ["evidenceLevel", control.evidenceLevel],
      ["relatedFindingsOrDecisions", control.relatedFindingsOrDecisions],
    ]) {
      if (canonicalJson(entry?.[field]) !== canonicalJson(expectedValue)) {
        findings.push(`${label} ledger ${field} differs from the protected control catalog`);
      }
    }
    const tools = Array.isArray(entry?.toolVersions) ? entry.toolVersions : [];
    if (canonicalJson(tools) !== canonicalJson([control.tool])) {
      findings.push(`${label} ledger toolVersions must exactly match the protected control catalog`);
    }
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return true;
}

async function validateCatalogSemantics(document, findings) {
  const runnerBytes = await readFile(path.join(repoRoot, PRODUCTION_CONTROL_RUNNER_PATH));
  const runnerVersion = `sha256:${sha256Bytes(runnerBytes)}`;
  const gateIds = document.gates?.map((gate) => gate.gateId) ?? [];
  if (canonicalJson(document.capacityProfile) !== canonicalJson(PROPOSED_CAPACITY_PROFILE)) {
    findings.push("control catalog capacityProfile must equal the protected proposed production baseline");
  }
  if (document.capacityProfile?.workerReplicas * document.capacityProfile?.runtimeConcurrencyPerReplica
    !== document.capacityProfile?.activeRuns) {
    findings.push("control catalog capacityProfile worker capacity must equal activeRuns");
  }
  const derivedPollerQps = Math.ceil(
    document.capacityProfile?.runtimeConcurrencyPerReplica / document.capacityProfile?.cancellationQueryBatchSize,
  ) * (1_000 / document.capacityProfile?.pollIntervalMs);
  if (!Number.isFinite(derivedPollerQps) || derivedPollerQps > document.capacityProfile?.maxPollerQpsPerReplica) {
    findings.push("control catalog capacityProfile exceeds maxPollerQpsPerReplica");
  }
  if (canonicalJson(gateIds) !== canonicalJson(REQUIRED_PRODUCTION_GATES)) {
    findings.push(`control catalog gates must be exactly ${REQUIRED_PRODUCTION_GATES.join(", ")} in order`);
  }
  const allControlIds = new Set();
  for (const gate of document.gates ?? []) {
    const ids = gate.controls?.map((control) => control.controlId) ?? [];
    if (canonicalJson(ids) !== canonicalJson([...ids].sort(compareStrings))) {
      findings.push(`${gate.gateId} controls must be sorted by controlId`);
    }
    for (const control of gate.controls ?? []) {
      if (!control.controlId.startsWith(`${gate.gateId}.`)) {
        findings.push(`${control.controlId} must be prefixed by ${gate.gateId}.`);
      }
      if (allControlIds.has(control.controlId)) findings.push(`${control.controlId} is duplicated`);
      allControlIds.add(control.controlId);
      validateExecutableProcedure(control, runnerVersion, findings);
      await validateExecutionMapping(control, findings);
    }
  }
  for (const [controlId, threshold] of CAPACITY_THRESHOLDS) {
    const control = document.gates
      ?.flatMap((gate) => gate.controls ?? [])
      .find((candidate) => candidate.controlId === controlId);
    if (!control || canonicalJson(control.threshold) !== canonicalJson(threshold)) {
      findings.push(`${controlId} must keep its protected production capacity threshold`);
    }
  }
  const passwordControl = document.gates
    ?.flatMap((gate) => gate.controls ?? [])
    .find((control) => control.controlId === "G6.AUTH.PASSWORD_LOGIN");
  if (!passwordControl?.prerequisites?.some((value) => value.includes("WORKBENCH_ENTERPRISE_SSO_ENABLED"))) {
    findings.push("G6.AUTH.PASSWORD_LOGIN must bind the enabled/disabled enterprise SSO branch to candidate configuration");
  }
  const registryIds = Object.keys(CONTROL_EXECUTION_REGISTRY).sort(compareStrings);
  if (canonicalJson(registryIds) !== canonicalJson([...allControlIds].sort(compareStrings))) {
    findings.push("production control execution registry must exactly cover the protected catalog");
  }
}

function validateExecutableProcedure(control, runnerVersion, findings) {
  const procedure = control?.procedure;
  const evidenceRootArgument = requiresG11RealStackManifest(control.controlId)
    ? ' --evidence-root "$WORKBENCH_EVIDENCE_ROOT" --trust-policy "$PRODUCTION_TRUST_POLICY" --trust-policy-sha256 "$PRODUCTION_TRUST_POLICY_SHA256"'
    : "";
  const expectedCommand = `node ${PRODUCTION_CONTROL_RUNNER_PATH} --control ${control.controlId} --plan "$WORKBENCH_ACCEPTANCE_PLAN" --result "$WORKBENCH_CONTROL_RESULT"${evidenceRootArgument} --output "$WORKBENCH_OBSERVATION_OUTPUT"`;
  if (procedure?.kind !== "command" || procedure.command !== expectedCommand) {
    findings.push(`${control.controlId} must execute the protected repository control runner`);
  }
  if (control.tool?.name !== PRODUCTION_CONTROL_RUNNER_NAME || control.tool?.version !== runnerVersion) {
    findings.push(`${control.controlId} tool identity must bind the protected runner source SHA-256`);
  }
}

function requiresG11RealStackManifest(controlId) {
  return controlId.startsWith("G11.") && controlId !== "G11.FIGMA.SCOPE";
}

async function validateExecutionMapping(control, findings) {
  const execution = executionForControl(control.controlId);
  if (!execution) {
    findings.push(`${control.controlId} has no protected execution mapping`);
    return;
  }
  const relativePath = execution.kind === "command" ? execution.argv?.[1] : execution.path;
  if (typeof relativePath !== "string" || (!relativePath.startsWith("scripts/") && !relativePath.startsWith("deploy/") && !relativePath.startsWith("docs/runbooks/"))) {
    findings.push(`${control.controlId} execution mapping path is invalid`);
    return;
  }
  let bytes;
  try {
    bytes = await readFile(path.join(repoRoot, relativePath), "utf8");
  } catch (error) {
    findings.push(`${control.controlId} execution mapping target cannot be read: ${error.message}`);
    return;
  }
  if (execution.kind === "runbook" && !new RegExp(`^#{2,6} ${escapeRegExp(execution.section)}$`, "mu").test(bytes)) {
    findings.push(`${control.controlId} runbook section ${execution.section} does not exist`);
  }
}

function normalizeCatalogDocument(value) {
  const result = structuredClone(value);
  for (const gate of result.gates) {
    for (const control of gate.controls) {
      control.relatedFindingsOrDecisions.sort((left, right) => (
        compareStrings(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`)
      ));
    }
  }
  return result;
}

async function catalogSchemaValidator() {
  schemaValidatorPromise ??= readFile(schemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return schemaValidatorPromise;
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

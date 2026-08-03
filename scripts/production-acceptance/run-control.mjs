#!/usr/bin/env node

import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sha256Bytes,
  sha256Canonical,
} from "../evidence-ledger.mjs";
import { verifyProductionDeploymentRuntimeBinding } from "../production-deployment-config.mjs";
import { loadProductionTrustPolicy } from "../workbench-production-trust-policy.mjs";
import {
  ProductionAcceptanceContractError,
  loadProductionAcceptanceControlCatalog,
} from "./catalog.mjs";
import {
  PRODUCTION_CONTROL_RUNNER_PATH,
  executionForControl,
} from "./control-execution-registry.mjs";
import { evaluateThreshold } from "./collect.mjs";
import {
  PRODUCTION_G11_MANIFEST_EVIDENCE_KIND,
  PRODUCTION_G11_REAL_STACK_SCHEMA_PATH,
  isProductionG11RealStackControl,
  loadProductionG11RealStackManifest,
} from "./g11-real-stack-manifest.mjs";
import { loadProductionAcceptancePlan } from "./plan.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const CONTROL_RESULT_SCHEMA_VERSION = "workbench.production-control-result.v1";
export const CONTROL_OBSERVATION_SCHEMA_VERSION = "workbench.production-control-observation.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const runnerPath = path.join(repoRoot, PRODUCTION_CONTROL_RUNNER_PATH);
const observationSchemaPath = path.join(repoRoot, "docs/evidence/production-control-observation.schema.json");
const g11ManifestSchemaPath = path.join(repoRoot, PRODUCTION_G11_REAL_STACK_SCHEMA_PATH);
const g11ManifestVerifierPath = path.join(repoRoot, "scripts/production-acceptance/g11-real-stack-manifest.mjs");
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const G11_MANIFEST_SCHEMA_SHA256 = "b076b48d943e6bb57c93d991011becc886759c3cb51fee541da7f4c0b0010dd4";
const G11_MANIFEST_VERIFIER_SHA256 = "aa5a543610eaabacd96fccf907558525eae900e3a440afe9fe8cd9cb084ce92e";
let observationValidatorPromise;

export async function runProductionControl({
  controlId,
  planPath,
  resultPath,
  evidenceRoot,
  trustPolicyPath,
  expectedTrustPolicySha256,
  outputPath,
} = {}) {
  const findings = [];
  if (!IDENTIFIER_PATTERN.test(controlId ?? "")) findings.push("controlId is invalid");
  if (!planPath) findings.push("planPath is required");
  if (!resultPath) findings.push("resultPath is required");
  if (!outputPath) findings.push("outputPath is required");
  if (isProductionG11RealStackControl(controlId) && !evidenceRoot) {
    findings.push("evidenceRoot is required for production G11 real-stack controls");
  }
  if (isProductionG11RealStackControl(controlId) && !trustPolicyPath) {
    findings.push("trustPolicyPath is required for production G11 real-stack controls");
  }
  if (isProductionG11RealStackControl(controlId) && !SHA256_PATTERN.test(expectedTrustPolicySha256 ?? "")) {
    findings.push("expectedTrustPolicySha256 is required for production G11 real-stack controls");
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  const catalog = await loadProductionAcceptanceControlCatalog();
  const expected = catalog.byControl.get(controlId);
  if (!expected) throw new ProductionAcceptanceContractError([`${controlId} is not in the protected control catalog`]);
  const execution = executionForControl(controlId);
  if (!execution) throw new ProductionAcceptanceContractError([`${controlId} has no protected execution mapping`]);
  const loadedPlan = await loadProductionAcceptancePlan({ planPath, catalog });
  const resultArtifact = await readCanonicalDocument(resultPath, `${controlId} control result`);
  const runnerArtifact = await readStableRegularFile(runnerPath, "production control runner");
  const runnerSha256 = sha256Bytes(runnerArtifact.bytes);
  const result = resultArtifact.document;

  validateResult({ result, controlId, execution, expected, plan: loadedPlan.plan, runnerSha256, findings });
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);

  let g11Evidence = null;
  if (isProductionG11RealStackControl(controlId)) {
    await assertProtectedG11ManifestSchema();
    const trustPolicy = await loadProductionTrustPolicy({
      policyPath: trustPolicyPath,
      expectedSha256: expectedTrustPolicySha256,
    }).catch(() => {
      throw new ProductionAcceptanceContractError(["G11 external production trust policy validation failed"]);
    });
    try {
      verifyProductionDeploymentRuntimeBinding(loadedPlan.plan.payload.deploymentConfig, {
        environmentId: loadedPlan.plan.payload.binding.environmentId,
        trustPolicy,
      });
    } catch (error) {
      throw new ProductionAcceptanceContractError([
        `G11 signed deployment trust binding validation failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    g11Evidence = await loadProductionG11RealStackManifest({
      reference: result.execution.evidence,
      evidenceRoot,
      plan: loadedPlan.plan,
      executedAtUtc: result.executedAtUtc,
      trustPolicy,
    });
  }

  const observedValue = g11Evidence?.derived.get(controlId) ?? result.observedValue;
  const thresholdPassed = evaluateThreshold(expected.control.threshold, observedValue);
  const conditionalResult = validateConditionalResult({
    controlId,
    value: result.conditionalResult,
    enterpriseSsoEnabled: loadedPlan.plan.payload.deploymentConfig.identity.enterpriseSsoEnabled,
  });
  const observation = {
    schemaVersion: CONTROL_OBSERVATION_SCHEMA_VERSION,
    observationId: `observation-${sha256Canonical({
      controlId,
      planId: loadedPlan.plan.payload.planId,
      executedAtUtc: result.executedAtUtc,
      executionEvidenceSha256: result.execution.evidence.sha256,
    }).slice(0, 48)}`,
    controlId,
    gateId: expected.gateId,
    catalog: {
      schemaVersion: catalog.document.schemaVersion,
      sha256: catalog.sha256,
    },
    binding: loadedPlan.plan.payload.binding,
    environment: loadedPlan.plan.payload.environment,
    executedAtUtc: result.executedAtUtc,
    executor: result.executor,
    toolVersions: [expected.control.tool],
    toolAttestation: result.toolAttestation,
    evidenceLevel: expected.control.evidenceLevel,
    result: {
      executionStatus: thresholdPassed && conditionalResultPassed(conditionalResult) ? "PASS" : "FAIL",
      observedValue,
      summary: g11Evidence
        ? g11Summary(controlId, observedValue, g11Evidence.manifest.manifestId)
        : result.summary,
    },
    evidence: g11Evidence
      ? uniqueEvidence([
        {
          kind: PRODUCTION_G11_MANIFEST_EVIDENCE_KIND,
          uri: result.execution.evidence.uri,
          sha256: result.execution.evidence.sha256,
        },
        ...g11Evidence.evidence,
      ])
      : uniqueEvidence([
        {
          kind: executionEvidenceKind(execution),
          uri: result.execution.evidence.uri,
          sha256: result.execution.evidence.sha256,
        },
        ...result.evidence,
      ]),
    retryRecords: result.retryRecords,
  };
  await validateObservationDocument(observation);
  const destination = await validateOutputPath(outputPath);
  const raw = Buffer.from(canonicalJsonFile(observation), "utf8");
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({ observation, outputPath: destination, sha256: sha256Bytes(raw) });
}

function validateResult({ result, controlId, execution, expected, plan, runnerSha256, findings }) {
  exactKeys(result, [
    "schemaVersion", "controlId", "executedAtUtc", "executor", "observedValue", "summary",
    "conditionalResult", "execution", "toolAttestation", "evidence", "retryRecords",
  ], "control result", findings);
  if (result?.schemaVersion !== CONTROL_RESULT_SCHEMA_VERSION) findings.push("control result schemaVersion is invalid");
  if (result?.controlId !== controlId) findings.push("control result controlId mismatch");
  if (!isCanonicalUtcDateTime(result?.executedAtUtc)) findings.push("control result executedAtUtc is invalid");
  if (isCanonicalUtcDateTime(result?.executedAtUtc)
    && new Date(result.executedAtUtc) < new Date(plan.payload.createdAtUtc)) {
    findings.push("control result predates the frozen plan");
  }
  exactKeys(result?.executor, ["id", "kind"], "control result executor", findings);
  if (!IDENTIFIER_PATTERN.test(result?.executor?.id ?? "")) findings.push("control result executor.id is invalid");
  if (!["person", "auditor", "ci", "automation"].includes(result?.executor?.kind)) {
    findings.push("control result executor.kind is invalid");
  }
  if (!(typeof result?.observedValue === "boolean"
    || (typeof result?.observedValue === "number" && Number.isFinite(result.observedValue)))) {
    findings.push("control result observedValue must be a finite number or boolean");
  }
  if (typeof result?.summary !== "string" || result.summary.length < 1 || result.summary.length > 4096) {
    findings.push("control result summary is invalid");
  }
  validateExecution(result?.execution, execution, controlId, findings);
  validateToolAttestation(result?.toolAttestation, expected.control.tool, runnerSha256, findings);
  if (!Array.isArray(result?.evidence)) findings.push("control result evidence must be an array");
  else {
    if (isProductionG11RealStackControl(controlId) && result.evidence.length !== 0) {
      findings.push(`${controlId} evidence must be derived exclusively from its G11 real-stack manifest`);
    }
    for (const [index, reference] of result.evidence.entries()) {
      validateTypedReference(reference, `control result evidence[${index}]`, findings);
    }
  }
  validateRetryRecords(result?.retryRecords, plan, findings);
}

function validateExecution(value, expected, controlId, findings) {
  exactKeys(value, ["kind", "source", "evidence"], "control result execution", findings);
  if (value?.kind !== expected.kind) findings.push(`${controlId} execution kind differs from its protected registry`);
  if (canonicalJson(value?.source) !== canonicalJson(executionSource(expected))) {
    findings.push(`${controlId} execution source differs from its protected registry`);
  }
  validateReference(value?.evidence, "control result execution evidence", findings);
}

function validateToolAttestation(value, tool, runnerSha256, findings) {
  exactKeys(value, ["name", "version", "artifact", "provenance", "provenanceSubjectSha256"], "toolAttestation", findings);
  if (value?.name !== tool.name || value?.version !== tool.version) findings.push("toolAttestation identity mismatch");
  if (tool.version !== `sha256:${runnerSha256}`) findings.push("catalog runner version does not match protected source bytes");
  validateReference(value?.artifact, "toolAttestation artifact", findings);
  validateReference(value?.provenance, "toolAttestation provenance", findings);
  if (value?.artifact?.sha256 !== runnerSha256) findings.push("toolAttestation artifact is not the protected runner source");
  if (value?.provenanceSubjectSha256 !== runnerSha256) findings.push("tool provenance subject mismatch");
}

function validateConditionalResult({ controlId, value, enterpriseSsoEnabled }) {
  if (controlId !== "G6.AUTH.PASSWORD_LOGIN") {
    if (value !== null) throw new ProductionAcceptanceContractError([`${controlId} conditionalResult must be null`]);
    return null;
  }
  const findings = [];
  exactKeys(value, ["condition", "configured", "selectedBranch", "passed"], "enterprise SSO conditional result", findings);
  if (value?.condition !== "WORKBENCH_ENTERPRISE_SSO_ENABLED") findings.push("enterprise SSO condition is invalid");
  if (value?.configured !== enterpriseSsoEnabled) findings.push("enterprise SSO condition differs from signed deployment identity");
  if (value?.selectedBranch !== (enterpriseSsoEnabled ? "enabled" : "disabled")) findings.push("enterprise SSO branch is invalid");
  if (value?.passed !== true) findings.push("enterprise SSO selected branch did not pass");
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
  return structuredClone(value);
}

function conditionalResultPassed(value) {
  return value === null || value.passed === true;
}

function executionSource(execution) {
  return execution.kind === "command"
    ? { argv: [...execution.argv], evidenceKind: execution.evidenceKind }
    : { path: execution.path, section: execution.section };
}

function executionEvidenceKind(execution) {
  return execution.kind === "command" ? execution.evidenceKind : "runbook-execution-evidence";
}

function g11Summary(controlId, observedValue, manifestId) {
  return `${controlId} derived ${JSON.stringify(observedValue)} from validated G11 manifest ${manifestId}.`;
}

function validateReference(value, label, findings) {
  exactKeys(value, ["uri", "sha256"], label, findings);
  if (typeof value?.uri !== "string" || value.uri.length < 1 || value.uri.length > 2048) findings.push(`${label}.uri is invalid`);
  if (!SHA256_PATTERN.test(value?.sha256 ?? "")) findings.push(`${label}.sha256 is invalid`);
}

function validateTypedReference(value, label, findings) {
  exactKeys(value, ["kind", "uri", "sha256"], label, findings);
  if (!IDENTIFIER_PATTERN.test(value?.kind ?? "")) findings.push(`${label}.kind is invalid`);
  if (typeof value?.uri !== "string" || value.uri.length < 1 || value.uri.length > 2048) findings.push(`${label}.uri is invalid`);
  if (!SHA256_PATTERN.test(value?.sha256 ?? "")) findings.push(`${label}.sha256 is invalid`);
}

function validateRetryRecords(value, plan, findings) {
  if (!Array.isArray(value)) {
    findings.push("control result retryRecords must be an array");
    return;
  }
  const attempts = new Set();
  for (const [index, retry] of value.entries()) {
    const label = `control result retryRecords[${index}]`;
    exactKeys(retry, ["attempt", "executedAtUtc", "executionStatus", "reason", "evidence"], label, findings);
    if (!Number.isSafeInteger(retry?.attempt) || retry.attempt < 1) findings.push(`${label}.attempt is invalid`);
    else if (attempts.has(retry.attempt)) findings.push(`${label}.attempt is duplicated`);
    else attempts.add(retry.attempt);
    if (!isCanonicalUtcDateTime(retry?.executedAtUtc)) findings.push(`${label}.executedAtUtc is invalid`);
    else if (new Date(retry.executedAtUtc) < new Date(plan.payload.createdAtUtc)) findings.push(`${label} predates the frozen plan`);
    if (!["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"].includes(retry?.executionStatus)) {
      findings.push(`${label}.executionStatus is invalid`);
    }
    if (typeof retry?.reason !== "string" || retry.reason.length < 1 || retry.reason.length > 4096) {
      findings.push(`${label}.reason is invalid`);
    }
    if (!Array.isArray(retry?.evidence) || retry.evidence.length < 1) findings.push(`${label}.evidence must be a non-empty array`);
    else for (const [evidenceIndex, reference] of retry.evidence.entries()) {
      validateReference(reference, `${label}.evidence[${evidenceIndex}]`, findings);
    }
  }
}

function uniqueEvidence(values) {
  const sorted = structuredClone(values).sort((left, right) => left.uri.localeCompare(right.uri, "en"));
  if (new Set(sorted.map((value) => value.uri)).size !== sorted.length) {
    throw new ProductionAcceptanceContractError(["control result contains duplicate evidence URIs"]);
  }
  return sorted;
}

async function assertProtectedG11ManifestSchema() {
  const [schemaArtifact, verifierArtifact] = await Promise.all([
    readStableRegularFile(g11ManifestSchemaPath, "protected G11 manifest schema"),
    readStableRegularFile(g11ManifestVerifierPath, "protected G11 manifest verifier"),
  ]);
  const schemaSha256 = sha256Bytes(schemaArtifact.bytes);
  const verifierSha256 = sha256Bytes(verifierArtifact.bytes);
  const findings = [];
  if (schemaSha256 !== G11_MANIFEST_SCHEMA_SHA256) {
    findings.push(
      `protected G11 manifest schema SHA-256 mismatch: expected ${G11_MANIFEST_SCHEMA_SHA256}, got ${schemaSha256}`,
    );
  }
  if (verifierSha256 !== G11_MANIFEST_VERIFIER_SHA256) {
    findings.push(
      `protected G11 manifest verifier SHA-256 mismatch: expected ${G11_MANIFEST_VERIFIER_SHA256}, got ${verifierSha256}`,
    );
  }
  if (findings.length > 0) {
    throw new ProductionAcceptanceContractError([
      ...findings,
    ]);
  }
}

async function validateObservationDocument(observation) {
  const validate = await observationSchemaValidator();
  if (validate(observation)) return true;
  throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
    `generated production control observation${error.instancePath || "/"} ${error.message}`
  )));
}

async function observationSchemaValidator() {
  observationValidatorPromise ??= readFile(observationSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return observationValidatorPromise;
}

async function readCanonicalDocument(candidatePath, label) {
  const artifact = await readStableRegularFile(candidatePath, label);
  let document;
  try {
    document = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([`${label} is not valid JSON: ${error.message}`]);
  }
  if (artifact.bytes.toString("utf8") !== canonicalJsonFile(document)) {
    throw new ProductionAcceptanceContractError([`${label} must be canonical JSON with one trailing LF`]);
  }
  return { ...artifact, document };
}

async function readStableRegularFile(candidatePath, label) {
  const resolved = path.resolve(candidatePath ?? "");
  const before = await lstat(resolved).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!before.isFile() || before.isSymbolicLink()) throw new ProductionAcceptanceContractError([`${label} must be a regular non-symlink file`]);
  const canonical = await realpath(resolved);
  const bytes = await readFile(canonical);
  const after = await lstat(canonical);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ProductionAcceptanceContractError([`${label} changed while it was read`]);
  }
  return { path: canonical, bytes };
}

async function validateOutputPath(candidatePath) {
  const resolved = path.resolve(candidatePath ?? "");
  const parent = await realpath(path.dirname(resolved));
  const destination = path.join(parent, path.basename(resolved));
  if (isWithin(repoRoot, destination)) throw new ProductionAcceptanceContractError(["observation output must be outside the source repository"]);
  return destination;
}

function exactKeys(value, expected, label, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(`${label} must be an object`);
    return;
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    findings.push(`${label} must contain exactly: ${[...expected].sort().join(", ")}`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseArguments(argv) {
  const values = {};
  const aliases = new Map([
    ["--control", "controlId"],
    ["--plan", "planPath"],
    ["--result", "resultPath"],
    ["--evidence-root", "evidenceRoot"],
    ["--trust-policy", "trustPolicyPath"],
    ["--trust-policy-sha256", "expectedTrustPolicySha256"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    if (Object.hasOwn(values, key)) throw new Error(`${argv[index - 1]} was provided more than once`);
    values[key] = value;
  }
  return values;
}

async function main() {
  try {
    const report = await runProductionControl(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ status: report.observation.result.executionStatus, output: report.outputPath, sha256: report.sha256 })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

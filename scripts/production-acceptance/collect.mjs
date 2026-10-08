#!/usr/bin/env node

import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  canonicalJsonFile,
  sealEvidenceLedger,
  sha256Bytes,
  sha256Canonical,
  verifyEvidenceLedger,
} from "../evidence-ledger.mjs";
import {
  CONTROL_CATALOG_PACKAGE_PATH,
  DEFAULT_CONTROL_CATALOG_PATH,
  ProductionAcceptanceContractError,
  assertGateEntriesMatchCatalog,
  loadProductionAcceptanceControlCatalog,
} from "./catalog.mjs";
import { loadProductionAcceptancePlan } from "./plan.mjs";
import { createStrictAjv2020, isCanonicalUtcDateTime } from "./schema.mjs";

export const CONTROL_OBSERVATION_SCHEMA_VERSION = "workbench.production-control-observation.v1";
export const OBSERVATION_COLLECTION_SCHEMA_VERSION = "workbench.production-observation-collection.v1";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const observationSchemaPath = path.join(repoRoot, "schemas/evidence/production-control-observation.schema.json");
const collectionSchemaPath = path.join(repoRoot, "schemas/evidence/production-observation-collection.schema.json");
const FILE_URI_PATTERN = /^file:\.\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
let observationValidatorPromise;
let collectionValidatorPromise;

export async function collectProductionAcceptanceEvidence({
  planPath,
  catalogPath = DEFAULT_CONTROL_CATALOG_PATH,
  observationsDirectory,
  evidenceRoot,
  outputRoot,
  collectedAtUtc,
} = {}) {
  requireUtc(collectedAtUtc, "collectedAtUtc");
  const catalog = await loadProductionAcceptanceControlCatalog({ catalogPath });
  const loadedPlan = await loadProductionAcceptancePlan({ planPath, catalog });
  const plan = loadedPlan.plan;
  const sourceRoot = await canonicalDirectory(evidenceRoot, "evidence root");
  const observationRoot = await canonicalDirectory(observationsDirectory, "observations directory");
  assertWithin(sourceRoot, observationRoot, "observations directory must be inside the evidence root");
  const destinationRoot = path.resolve(outputRoot ?? "");
  await assertOutputRoot(destinationRoot, sourceRoot);

  const planTime = new Date(plan.payload.createdAtUtc);
  const collectedTime = new Date(collectedAtUtc);
  if (collectedTime < planTime) {
    throw new ProductionAcceptanceContractError(["collectedAtUtc must be no earlier than the plan"]);
  }

  const expectedControls = catalog.document.gates.flatMap((gate) => gate.controls.map((control) => ({
    gateId: gate.gateId,
    control,
  })));
  const expectedNames = expectedControls.map(({ control }) => `${control.controlId}.json`).sort(compareStrings);
  const actualEntries = await readdir(observationRoot, { withFileTypes: true });
  const actualNames = actualEntries.map((entry) => entry.name).sort(compareStrings);
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames) || actualEntries.some((entry) => !entry.isFile())) {
    throw new ProductionAcceptanceContractError([
      "observations directory must contain exactly one regular <controlId>.json file for every catalog control",
    ]);
  }

  await mkdir(destinationRoot, { mode: 0o700 });
  const sentinelPath = path.join(destinationRoot, ".incomplete");
  await writeExclusive(sentinelPath, `${OBSERVATION_COLLECTION_SCHEMA_VERSION}\n`);
  try {
    await copyArtifact(loadedPlan.raw, path.join(destinationRoot, "governance/production-acceptance-plan.json"));
    await copyArtifact(catalog.raw, path.join(destinationRoot, CONTROL_CATALOG_PACKAGE_PATH));

    const observations = [];
    const copiedLocalEvidence = new Map();
    for (const expected of expectedControls) {
      const sourcePath = path.join(observationRoot, `${expected.control.controlId}.json`);
      const loaded = await loadProductionControlObservation({ sourcePath });
      assertObservationMatchesPlanAndControl({
        observation: loaded.observation,
        expected,
        plan,
        catalog,
        collectedTime,
      });
      const packagedObservationPath = `observations/${expected.control.controlId}.json`;
      await copyArtifact(loaded.raw, path.join(destinationRoot, packagedObservationPath));
      for (const reference of observationEvidenceReferences(loaded.observation)) {
        await materializeLocalEvidence({
          reference,
          sourceRoot,
          destinationRoot,
          copiedLocalEvidence,
        });
      }
      observations.push({
        ...loaded,
        expected,
        packagedObservationPath,
        packagedObservationSha256: sha256Bytes(loaded.raw),
      });
    }

    const gateResults = [];
    for (const gate of catalog.document.gates) {
      const gateObservations = observations.filter((item) => item.expected.gateId === gate.gateId);
      const entries = gateObservations.map((item) => ledgerEntry(item, plan));
      const ledger = sealEvidenceLedger({
        ledgerId: `production-${gate.gateId.toLowerCase()}-${plan.payload.planId.slice(-24)}`,
        createdAtUtc: collectedAtUtc,
        binding: ledgerBinding(plan.payload.binding),
        previousLedger: null,
        entries,
      });
      assertGateEntriesMatchCatalog({ gateId: gate.gateId, entries: ledger.payload.entries, catalog });
      const relativePath = `gates/${gate.gateId.toLowerCase()}.json`;
      const ledgerRaw = Buffer.from(canonicalJsonFile(ledger), "utf8");
      await copyArtifact(ledgerRaw, path.join(destinationRoot, relativePath));
      await verifyEvidenceLedger({
        ledgerPath: path.join(destinationRoot, relativePath),
        root: destinationRoot,
        expectedBinding: ledgerBinding(plan.payload.binding),
      });
      const status = ledger.payload.entries.every((entry) => entry.executionStatus === "PASS") ? "PASS" : "FAIL";
      gateResults.push({
        gateId: gate.gateId,
        status,
        controlCount: ledger.payload.entries.length,
        observedAtUtc: latestTimestamp(ledger.payload.entries.map((entry) => entry.executedAtUtc)),
        ledger: { path: relativePath, sha256: sha256Bytes(ledgerRaw) },
      });
    }

    const status = gateResults.every((gate) => gate.status === "PASS") ? "PASS" : "FAIL";
    const summaryPayload = {
      collectionId: `production-collection-${plan.payload.planId.slice(-24)}`,
      collectedAtUtc,
      status,
      plan: { path: "governance/production-acceptance-plan.json", sha256: loadedPlan.sha256 },
      catalog: {
        schemaVersion: catalog.document.schemaVersion,
        path: CONTROL_CATALOG_PACKAGE_PATH,
        sha256: catalog.sha256,
      },
      binding: plan.payload.binding,
      gates: gateResults,
    };
    const summary = {
      schemaVersion: OBSERVATION_COLLECTION_SCHEMA_VERSION,
      payload: summaryPayload,
      payloadSha256: sha256Canonical({
        schemaVersion: OBSERVATION_COLLECTION_SCHEMA_VERSION,
        payload: summaryPayload,
      }),
    };
    await validateProductionObservationCollection(summary);
    await copyArtifact(Buffer.from(canonicalJsonFile(summary), "utf8"), path.join(destinationRoot, "collection.json"));
    await unlink(sentinelPath);
    return { status, outputRoot: destinationRoot, summary, gateResults };
  } catch (error) {
    throw error;
  }
}

export async function loadProductionControlObservation({ sourcePath } = {}) {
  const artifact = await readStableRegularFile(sourcePath, "production control observation");
  let observation;
  try {
    observation = JSON.parse(artifact.bytes.toString("utf8"));
  } catch (error) {
    throw new ProductionAcceptanceContractError([
      `production control observation is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (artifact.bytes.toString("utf8") !== canonicalJsonFile(observation)) {
    throw new ProductionAcceptanceContractError(["production control observation must be canonical JSON with one trailing LF"]);
  }
  const validate = await observationSchemaValidator();
  if (!validate(observation)) {
    throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
      `production control observation${error.instancePath || "/"} ${error.message}`
    )));
  }
  return { observation, raw: artifact.bytes, path: artifact.path };
}

export function evaluateThreshold(threshold, observedValue) {
  if (threshold.kind === "boolean") return typeof observedValue === "boolean" && observedValue === threshold.expected;
  if (typeof observedValue !== "number" || !Number.isFinite(observedValue)) return false;
  if (threshold.operator === "eq") return observedValue === threshold.expected;
  if (threshold.operator === "lt") return observedValue < threshold.expected;
  if (threshold.operator === "lte") return observedValue <= threshold.expected;
  if (threshold.operator === "gt") return observedValue > threshold.expected;
  if (threshold.operator === "gte") return observedValue >= threshold.expected;
  return false;
}

export async function validateProductionObservationCollection(document) {
  const validate = await collectionSchemaValidator();
  if (validate(document)) return true;
  throw new ProductionAcceptanceContractError((validate.errors ?? []).map((error) => (
    `production observation collection${error.instancePath || "/"} ${error.message}`
  )));
}

export function assertObservationMatchesPlanAndControl({ observation, expected, plan, catalog, collectedTime }) {
  const findings = [];
  const control = expected.control;
  if (observation.controlId !== control.controlId) findings.push(`${control.controlId} observation controlId mismatch`);
  if (observation.gateId !== expected.gateId) findings.push(`${control.controlId} observation gateId mismatch`);
  if (observation.catalog.schemaVersion !== catalog.document.schemaVersion
    || observation.catalog.sha256 !== catalog.sha256) {
    findings.push(`${control.controlId} observation catalog binding mismatch`);
  }
  if (canonicalJson(observation.binding) !== canonicalJson(plan.payload.binding)) {
    findings.push(`${control.controlId} observation candidate/deploy/digest binding mismatch`);
  }
  if (canonicalJson(observation.environment) !== canonicalJson(plan.payload.environment)) {
    findings.push(`${control.controlId} observation environment mismatch`);
  }
  if (observation.evidenceLevel !== control.evidenceLevel) {
    findings.push(`${control.controlId} observation evidence level must be ${control.evidenceLevel}`);
  }
  if (canonicalJson(observation.toolVersions) !== canonicalJson([control.tool])) {
    findings.push(`${control.controlId} observation toolVersions must exactly match the protected control catalog`);
  }
  if (observation.toolAttestation.name !== control.tool.name
    || observation.toolAttestation.version !== control.tool.version) {
    findings.push(`${control.controlId} tool attestation does not identify the protected catalog tool`);
  }
  if (observation.toolAttestation.provenanceSubjectSha256 !== observation.toolAttestation.artifact.sha256) {
    findings.push(`${control.controlId} tool provenance subject does not match the attested artifact`);
  }
  const executedAt = new Date(observation.executedAtUtc);
  if (executedAt < new Date(plan.payload.createdAtUtc) || executedAt > collectedTime) {
    findings.push(`${control.controlId} observation time must be between plan creation and collection`);
  }
  const thresholdPassed = evaluateThreshold(control.threshold, observation.result.observedValue);
  if (observation.result.executionStatus === "PASS" && !thresholdPassed) {
    findings.push(`${control.controlId} claims PASS but its observed value does not meet the catalog threshold`);
  }
  const evidenceUris = observationEvidenceReferences(observation).map((reference) => reference.uri);
  if (new Set(evidenceUris).size !== evidenceUris.length) findings.push(`${control.controlId} contains duplicate evidence URIs`);
  for (const reference of observationEvidenceReferences(observation)) {
    const classification = classifyImmutableEvidence(reference);
    if (!classification.ok) findings.push(`${control.controlId} evidence ${reference.uri}: ${classification.error}`);
  }
  if (findings.length > 0) throw new ProductionAcceptanceContractError(findings);
}

function ledgerEntry(item, plan) {
  const observation = item.observation;
  const control = item.expected.control;
  const evidence = [
    { uri: `file:./${item.packagedObservationPath}`, sha256: item.packagedObservationSha256 },
    observation.toolAttestation.artifact,
    observation.toolAttestation.provenance,
    ...observation.evidence.map(({ uri, sha256 }) => ({ uri, sha256 })),
  ];
  return {
    entryId: control.controlId,
    gateId: item.expected.gateId,
    controlObjective: control.controlObjective,
    environment: plan.payload.environment,
    prerequisites: control.prerequisites,
    procedure: control.procedure,
    expectedObservation: control.expectedObservation,
    threshold: control.threshold,
    findingStatus: "CONFIRMED",
    executionStatus: observation.result.executionStatus,
    evidenceLevel: observation.evidenceLevel,
    executedAtUtc: observation.executedAtUtc,
    executor: observation.executor,
    binding: ledgerBinding(plan.payload.binding),
    toolVersions: observation.toolVersions,
    evidence,
    retryRecords: observation.retryRecords,
    relatedFindingsOrDecisions: control.relatedFindingsOrDecisions,
  };
}

function ledgerBinding(binding) {
  return structuredClone(binding);
}

function observationEvidenceReferences(observation) {
  return [
    observation.toolAttestation.artifact,
    observation.toolAttestation.provenance,
    ...observation.evidence.map(({ uri, sha256 }) => ({ uri, sha256 })),
    ...observation.retryRecords.flatMap((retry) => retry.evidence),
  ];
}

async function materializeLocalEvidence({ reference, sourceRoot, destinationRoot, copiedLocalEvidence }) {
  const classified = classifyImmutableEvidence(reference);
  if (!classified.ok) throw new ProductionAcceptanceContractError([classified.error]);
  if (classified.kind !== "file") return;
  if (!classified.relativePath.startsWith("raw/")) {
    throw new ProductionAcceptanceContractError([`${reference.uri} local production evidence must be under file:./raw/`]);
  }
  const sourcePath = path.resolve(sourceRoot, classified.relativePath);
  assertWithin(sourceRoot, sourcePath, `${reference.uri} escapes the evidence root`);
  const artifact = await readStableRegularFile(sourcePath, `evidence ${reference.uri}`);
  const actualSha256 = sha256Bytes(artifact.bytes);
  if (actualSha256 !== reference.sha256) {
    throw new ProductionAcceptanceContractError([
      `${reference.uri} SHA-256 mismatch: expected ${reference.sha256}, got ${actualSha256}`,
    ]);
  }
  const prior = copiedLocalEvidence.get(classified.relativePath);
  if (prior && prior !== actualSha256) {
    throw new ProductionAcceptanceContractError([`${reference.uri} is reused with different bytes`]);
  }
  if (!prior) {
    await copyArtifact(artifact.bytes, path.join(destinationRoot, classified.relativePath));
    copiedLocalEvidence.set(classified.relativePath, actualSha256);
  }
}

function classifyImmutableEvidence(reference) {
  if (!reference || typeof reference.uri !== "string" || !SHA256_PATTERN.test(reference.sha256 ?? "")) {
    return { ok: false, error: "evidence reference is invalid" };
  }
  const local = reference.uri.match(FILE_URI_PATTERN);
  if (local) {
    if (local[1].split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      return { ok: false, error: "local evidence path is unsafe" };
    }
    return { ok: true, kind: "file", relativePath: local[1] };
  }
  if (reference.uri === `urn:sha256:${reference.sha256}`) return { ok: true, kind: "remote" };
  if (/^oci:\/\/[^\s?#]+@sha256:[a-f0-9]{64}$/u.test(reference.uri)
    && reference.uri.endsWith(reference.sha256)) return { ok: true, kind: "remote" };
  try {
    const url = new URL(reference.uri);
    const credentialParameter = [...url.searchParams.keys()].some((key) => (
      /(?:token|secret|credential|signature|sig|auth|key)/iu.test(key)
    ));
    const version = url.searchParams.get("versionId")
      ?? url.searchParams.get("generation")
      ?? url.searchParams.get("versionid");
    const digest = url.searchParams.get("sha256") ?? url.searchParams.get("digest");
    const pinned = url.href.includes(reference.sha256)
      || version
      || digest === reference.sha256
      || digest === `sha256:${reference.sha256}`;
    if (url.protocol === "https:" && !url.username && !url.password && !url.hash && !credentialParameter && pinned) {
      return { ok: true, kind: "remote" };
    }
  } catch {
    // Report the common error below.
  }
  return { ok: false, error: "evidence URI is not immutable and credential-free" };
}

async function observationSchemaValidator() {
  observationValidatorPromise ??= readFile(observationSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return observationValidatorPromise;
}

async function collectionSchemaValidator() {
  collectionValidatorPromise ??= readFile(collectionSchemaPath, "utf8").then((raw) => (
    createStrictAjv2020().compile(JSON.parse(raw))
  ));
  return collectionValidatorPromise;
}

async function copyArtifact(bytes, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(destination, value) {
  await copyArtifact(Buffer.from(value, "utf8"), destination);
}

async function readStableRegularFile(candidatePath, label) {
  const resolvedPath = path.resolve(candidatePath ?? "");
  const before = await lstat(resolvedPath).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new ProductionAcceptanceContractError([`${label} must be a regular non-symlink file`]);
  }
  const canonicalPath = await realpath(resolvedPath);
  const bytes = await readFile(canonicalPath);
  const after = await lstat(canonicalPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new ProductionAcceptanceContractError([`${label} changed while it was read`]);
  }
  return { path: canonicalPath, bytes };
}

async function canonicalDirectory(candidatePath, label) {
  const resolvedPath = path.resolve(candidatePath ?? "");
  const info = await lstat(resolvedPath).catch((error) => {
    throw new ProductionAcceptanceContractError([`${label} cannot be read: ${error.message}`]);
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProductionAcceptanceContractError([`${label} must be a real directory`]);
  const canonicalPath = await realpath(resolvedPath);
  return canonicalPath;
}

async function assertOutputRoot(outputRoot, sourceRoot) {
  const canonicalRepo = await realpath(repoRoot);
  const canonicalParent = await realpath(path.dirname(outputRoot));
  const resolved = path.join(canonicalParent, path.basename(outputRoot));
  if (isWithin(canonicalRepo, resolved)) throw new ProductionAcceptanceContractError(["collection output must be outside the source repository"]);
  if (isWithin(sourceRoot, resolved) || isWithin(resolved, sourceRoot)) {
    throw new ProductionAcceptanceContractError(["collection output and source evidence roots must not overlap"]);
  }
  try {
    await lstat(resolved);
    throw new ProductionAcceptanceContractError(["collection output must not already exist"]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertWithin(root, candidate, message) {
  if (!isWithin(root, candidate)) throw new ProductionAcceptanceContractError([message]);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function latestTimestamp(values) {
  return [...values].sort((left, right) => {
    const difference = new Date(left).getTime() - new Date(right).getTime();
    return difference === 0 ? left.localeCompare(right, "en") : difference;
  }).at(-1);
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

function requireUtc(value, label) {
  if (!isCanonicalUtcDateTime(value)) {
    throw new ProductionAcceptanceContractError([`${label} must be a valid UTC timestamp`]);
  }
}

function parseArguments(argv) {
  const result = { catalogPath: DEFAULT_CONTROL_CATALOG_PATH };
  const names = new Map([
    ["--plan", "planPath"],
    ["--catalog", "catalogPath"],
    ["--observations", "observationsDirectory"],
    ["--evidence-root", "evidenceRoot"],
    ["--output-root", "outputRoot"],
    ["--collected-at", "collectedAtUtc"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = names.get(argv[index]);
    if (!key) throw new Error(`unsupported argument: ${argv[index]}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${argv[index - 1]} requires a value`);
    result[key] = value;
  }
  for (const key of ["planPath", "observationsDirectory", "evidenceRoot", "outputRoot", "collectedAtUtc"]) {
    if (!result[key]) throw new Error(`${key} is required`);
  }
  return result;
}

async function main() {
  let result;
  try {
    result = await collectProductionAcceptanceEvidence(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      outputRoot: result.outputRoot,
      gates: result.gateResults.map(({ gateId, status, controlCount }) => ({ gateId, status, controlCount })),
    })}\n`);
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyProductionBuildConfiguration } from "./write-production-build-configuration.mjs";

const WORKFLOW = ".github/workflows/workbench-owner-release.yml";
const ISSUER = "https://token.actions.githubusercontent.com";
const PROVENANCE = "https://slsa.dev/provenance/v1";
const SPDX = "https://spdx.dev/Document";
const IMAGE_SIGNATURE = "https://sigstore.dev/cosign/sign/v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function assert(value, message) { if (!value) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function createOwnerProvenance({ configuration, repository, workflowRun }) {
  verifyProductionBuildConfiguration(configuration, { id: configuration.id, sourceCommit: configuration.sourceCommit });
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository ?? ""), "provenance repository is required");
  assert(Number.isSafeInteger(workflowRun?.id) && workflowRun.id > 0 && Number.isSafeInteger(workflowRun?.attempt) && workflowRun.attempt > 0, "provenance workflow run and attempt are required");
  const source = `https://github.com/${repository}`;
  return {
    buildDefinition: {
      buildType: "https://workbench.dev/buildtypes/owner-image/v1",
      externalParameters: { repository, ref: "refs/heads/main", sourceCommit: configuration.sourceCommit, buildConfiguration: structuredClone(configuration) },
      internalParameters: { workflow: WORKFLOW },
      resolvedDependencies: [{ uri: `git+${source}@refs/heads/main`, digest: { gitCommit: configuration.sourceCommit } }],
    },
    runDetails: {
      builder: { id: `${source}/${WORKFLOW}@refs/heads/main` },
      metadata: { invocationId: `${source}/actions/runs/${workflowRun.id}/attempts/${workflowRun.attempt}` },
    },
  };
}

export function verifyAttestationStatement(statement, { record, kind, repository, workflowRun, sbom }) {
  assert(["https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"].includes(statement?._type), "attestation must use an in-toto statement");
  const repositoryName = record.imageRef.split("@")[0].replace(/:[^/]+$/u, "");
  if (kind === "signature") {
    // Cosign 3 signs image digests as an in-toto statement with an unnamed subject.
    assert(statement.subject?.length === 1
      && [undefined, "", repositoryName].includes(statement.subject[0].name)
      && equal(statement.subject[0].digest, { sha256: record.digest.slice(7) }), "image signature subject must match the exact image digest");
    assert(statement.predicateType === IMAGE_SIGNATURE && equal(statement.predicate, {}), "image signature must use the Cosign sign v1 predicate");
    return true;
  }
  assert(statement.subject?.length === 1 && statement.subject[0].name === repositoryName
    && equal(statement.subject[0].digest, { sha256: record.digest.slice(7) }), "attestation subject must match the exact image repository and digest");
  if (kind === "provenance") {
    assert(statement.predicateType === PROVENANCE, "provenance must use SLSA v1");
    assert(equal(statement.predicate, createOwnerProvenance({ configuration: record.buildConfiguration, repository, workflowRun })), "provenance source, build configuration or workflow run mismatch");
  } else {
    assert(kind === "sbom" && statement.predicateType === SPDX, "SBOM must use SPDX");
    assert(/^SPDX-2\./u.test(sbom?.spdxVersion ?? "") && sbom.SPDXID === "SPDXRef-DOCUMENT", "SBOM must contain a valid SPDX document");
    assert(equal(statement.predicate, sbom), "signed SBOM does not match the image evidence");
  }
  return true;
}

export function verifyOwnerImageAttestations({ record, evidenceRoot, signatureRoot = evidenceRoot, repository, workflowRun, execute = execFileSync }) {
  assert(/^[a-z0-9-]+$/u.test(record.id ?? ""), "invalid attestation image id");
  assert(/^sha256:[a-f0-9]{64}$/u.test(record.digest ?? "") && record.imageRef.endsWith(`@${record.digest}`), "attestation image digest must be immutable");
  verifyProductionBuildConfiguration(record.buildConfiguration, { id: record.id, sourceCommit: record.sourceCommit });
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository ?? ""), "attestation repository is required");
  for (const root of new Set([evidenceRoot, signatureRoot])) {
    const stat = lstatSync(root);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), "attestation evidence root must be a regular directory");
  }
  const readEvidence = (name, expected, root = evidenceRoot) => {
    const filename = path.join(root, name);
    const stat = lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink(), `attestation evidence must be a regular file: ${name}`);
    const bytes = readFileSync(filename);
    assert(hash(bytes) === expected?.sha256, `attestation evidence hash mismatch: ${name}`);
    return { filename, document: JSON.parse(bytes) };
  };
  const sbom = readEvidence(`sbom-${record.id}.spdx.json`, record.sbom).document;
  const identity = `https://github.com/${repository}/${WORKFLOW}@refs/heads/main`;
  for (const [kind, name, evidence, type, root] of [
    ["signature", `cosign-${record.id}.bundle.json`, record.signature, IMAGE_SIGNATURE, signatureRoot],
    ["provenance", `provenance-${record.id}.bundle.json`, record.provenance, "slsaprovenance1", evidenceRoot],
    ["sbom", `sbom-attestation-${record.id}.bundle.json`, record.sbomAttestation, "spdxjson", evidenceRoot],
  ]) {
    const { filename, document } = readEvidence(name, evidence, root);
    // Cosign validates the DSSE signature, certificate identity, transparency
    // proof and image subject. Payload semantics are checked independently below.
    execute("cosign", ["verify-blob-attestation", "--bundle", filename, "--type", type,
      "--digest", record.digest.slice(7), "--digestAlg", "sha256", "--check-claims=true",
      "--certificate-identity", identity, "--certificate-oidc-issuer", ISSUER],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
    const envelope = document.dsseEnvelope;
    assert(envelope?.payloadType === "application/vnd.in-toto+json" && typeof envelope.payload === "string", "attestation bundle must contain a signed in-toto DSSE payload");
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    verifyAttestationStatement(statement, { record, kind, repository, workflowRun, sbom });
  }
  return true;
}

function main() {
  const [mode, ...values] = process.argv.slice(2);
  const args = Object.fromEntries(Array.from({ length: values.length / 2 }, (_, index) => [values[index * 2].replace(/^--/u, ""), values[index * 2 + 1]]));
  const repository = process.env.GITHUB_REPOSITORY;
  const workflowRun = { id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
  if (mode === "predicate") {
    const configuration = JSON.parse(readFileSync(args.configuration));
    writeFileSync(args.output, `${JSON.stringify(createOwnerProvenance({ configuration, repository, workflowRun }), null, 2)}\n`);
  } else if (mode === "verify") {
    verifyOwnerImageAttestations({ record: JSON.parse(readFileSync(args.record)), evidenceRoot: args["evidence-root"], repository, workflowRun });
    console.log("Exact image signature, SLSA provenance and SPDX attestation verified");
  } else throw new Error("expected predicate or verify command");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

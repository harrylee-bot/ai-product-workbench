import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";
import { createOwnerProvenance, verifyAttestationStatement, verifyOwnerImageAttestations } from "./owner-image-attestations.mjs";

const repository = "example/workbench";
const workflowRun = { id: 102, attempt: 2 };
const sourceCommit = "a".repeat(40);
const record = {
  id: "api", sourceCommit, digest: `sha256:${"b".repeat(64)}`,
  imageRef: `ghcr.io/example/workbench-api:${sourceCommit}@sha256:${"b".repeat(64)}`,
  buildConfiguration: createProductionBuildConfiguration({ id: "api", sourceCommit, dockerfile: "apps/workbench-api/Dockerfile", target: "runner", buildArgsSource: `NODE_IMAGE=node@sha256:${"c".repeat(64)}` }),
};
const sbom = { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", name: "api", packages: [{ SPDXID: "SPDXRef-node", name: "node", versionInfo: "22.23.3" }] };
const statement = (kind) => ({
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ ...(kind === "signature" ? {} : { name: "ghcr.io/example/workbench-api" }), digest: { sha256: record.digest.slice(7) } }],
  predicateType: kind === "signature" ? "https://sigstore.dev/cosign/sign/v1" : kind === "provenance" ? "https://slsa.dev/provenance/v1" : "https://spdx.dev/Document",
  predicate: kind === "signature" ? {} : kind === "provenance" ? createOwnerProvenance({ configuration: record.buildConfiguration, repository, workflowRun }) : structuredClone(sbom),
});
const options = (kind) => ({ record, kind, repository, workflowRun, sbom });

test("signed image predicates bind the immutable subject, complete source/configuration and exact workflow attempt", () => {
  for (const kind of ["signature", "provenance", "sbom"]) assert.equal(verifyAttestationStatement(statement(kind), options(kind)), true);
  for (const mutate of [
    (value) => { value.subject[0].digest.sha256 = "d".repeat(64); },
    (value) => { value.subject[0].name = "ghcr.io/foreign/api"; },
    (value) => { value.subject.push(value.subject[0]); },
    (value) => { value.predicate.buildDefinition.externalParameters.sourceCommit = "e".repeat(40); },
    (value) => { value.predicate.buildDefinition.externalParameters.buildConfiguration.buildArgs.NODE_IMAGE = "node:latest"; },
    (value) => { value.predicate.runDetails.metadata.invocationId = "https://github.com/example/workbench/actions/runs/102/attempts/1"; },
    (value) => { value.predicate.runDetails.builder.id = "https://github.com/foreign/workflow"; },
    (value) => { value.predicate.buildDefinition.resolvedDependencies = []; },
  ]) {
    const changed = statement("provenance"); mutate(changed);
    assert.throws(() => verifyAttestationStatement(changed, options("provenance")));
  }
  const changedSbom = statement("sbom"); changedSbom.predicate.packages[0].versionInfo = "unreviewed";
  assert.throws(() => verifyAttestationStatement(changedSbom, options("sbom")), /signed SBOM/);
  for (const mutate of [
    (value) => { value.subject[0].digest.sha256 = "d".repeat(64); },
    (value) => { value.subject[0].name = "ghcr.io/foreign/api"; },
    (value) => { value.subject.push(value.subject[0]); },
    (value) => { value.predicateType = "https://slsa.dev/provenance/v1"; },
    (value) => { value.predicate = { changed: true }; },
  ]) {
    const changed = statement("signature"); mutate(changed);
    assert.throws(() => verifyAttestationStatement(changed, options("signature")));
  }
});

test("deployment verifies all three Cosign bundles, checks evidence hashes and rejects failed signatures or forged payloads", async (t) => {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-attestations-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const candidate = structuredClone(record);
  const save = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(path.join(evidenceRoot, name), bytes);
    return { sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const bundle = (kind) => ({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement(kind))).toString("base64"), signatures: [{ sig: "verified by cosign" }] } });
  candidate.sbom = await save("sbom-api.spdx.json", sbom);
  candidate.signature = await save("cosign-api.bundle.json", bundle("signature"));
  candidate.provenance = await save("provenance-api.bundle.json", bundle("provenance"));
  candidate.sbomAttestation = await save("sbom-attestation-api.bundle.json", bundle("sbom"));
  const calls = [];
  const execute = (...args) => { calls.push(args); };
  const verifyOptions = { record: candidate, evidenceRoot, repository, workflowRun, execute };
  assert.equal(verifyOwnerImageAttestations(verifyOptions), true);
  assert.equal(calls.length, 3);
  for (const [command, args] of calls) {
    assert.equal(command, "cosign");
    assert.equal(args[0], "verify-blob-attestation");
    assert.equal(args[args.indexOf("--digest") + 1], candidate.digest.slice(7));
    assert.equal(args[args.indexOf("--digestAlg") + 1], "sha256");
    assert(args.includes("--check-claims=true"));
    assert(args.includes("https://github.com/example/workbench/.github/workflows/workbench-owner-release.yml@refs/heads/main"));
    assert(args.includes("https://token.actions.githubusercontent.com"));
    assert(!args.some((value) => /skip|check-claims=false/u.test(value)));
  }
  assert.throws(() => verifyOwnerImageAttestations({ ...verifyOptions, execute: () => { throw new Error("signature rejected"); } }), /signature rejected/);
  const forged = bundle("provenance");
  const payload = statement("provenance"); payload.subject[0].digest.sha256 = "d".repeat(64);
  forged.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  await save("provenance-api.bundle.json", forged);
  assert.throws(() => verifyOwnerImageAttestations(verifyOptions), /evidence hash mismatch/);
  candidate.provenance = await save("provenance-api.bundle.json", forged);
  assert.throws(() => verifyOwnerImageAttestations(verifyOptions), /exact image repository and digest/);
});

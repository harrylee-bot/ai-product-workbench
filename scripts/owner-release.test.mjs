import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import { canonicalJson } from "./evidence-ledger.mjs";
import { loadProductionImageInventory } from "./production-image-inventory.mjs";
import { createProductionBuildConfiguration } from "./write-production-build-configuration.mjs";
import {
  assertOwnerReleaseWorkflow,
  createOwnerRelease,
  OWNER_WORKFLOW,
  REQUIRED_CI_JOBS,
  verifyCiEvidence,
  verifyOwnerRelease,
  verifySourceFiles,
} from "./owner-release.mjs";

const commit = "a".repeat(40);
const repository = "example/workbench";
const source = {
  version: "1.0.0",
  repository,
  sourceCommit: commit,
  sourceTree: "b".repeat(40),
  sourceFiles: Object.fromEntries(["package.json", "package-lock.json", "scripts/owner-release.mjs", "scripts/owner-image-attestations.mjs", "scripts/production-image-inventory.mjs", "deploy/workbench-owner-deploy.py"].map((name) => [name, "d".repeat(64)])),
  workflow: OWNER_WORKFLOW,
  ref: "refs/heads/main",
  authorization: { kind: "project-owner-workflow-dispatch", actor: "project-owner", accepted: true },
  workflowRun: { id: 1000, attempt: 1 },
};

function ciEvidence() {
  return {
    run: {
      id: 99, run_attempt: 1, head_sha: commit,
      head_repository: { full_name: repository },
      path: ".github/workflows/workbench-ci.yml", head_branch: "main", event: "push",
      status: "completed", conclusion: "success",
    },
    jobs: REQUIRED_CI_JOBS.map((name, index) => ({ id: index + 1, name, status: "completed", conclusion: "success" })),
  };
}

function imageBytes() {
  const evidence = { sha256: "e".repeat(64), uri: `urn:sha256:${"e".repeat(64)}` };
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    candidate: { sourceCommit: commit },
    images: loadProductionImageInventory().candidateImages.map((image) => ({
      id: image.id,
      imageRef: `ghcr.io/example/workbench-${image.id}:${commit}@sha256:${"c".repeat(64)}`,
      digest: `sha256:${"c".repeat(64)}`,
      sourceCommit: commit,
      buildConfiguration: createProductionBuildConfiguration({
        id: image.id, sourceCommit: commit, dockerfile: image.dockerfile, target: image.target,
        buildArgsSource: `NODE_IMAGE=node:22-bookworm-slim@sha256:${"d".repeat(64)}`,
      }),
      sbom: evidence,
      sbomAttestation: evidence,
      provenance: evidence,
      signature: { ...evidence, verification: evidence },
      vulnerabilityReport: { ...evidence, status: "PASS", critical: 0, high: 0 },
    })),
  }));
}

test("owner release binds real CI and all ten immutable images to the same 1.0.0 commit", () => {
  const imageManifestBytes = imageBytes();
  const release = createOwnerRelease({ source, ciEvidence: ciEvidence(), imageManifestBytes });
  const manifest = verifyOwnerRelease(release, { expectedCommit: commit, repository, imageManifestBytes });
  assert.equal(manifest.images.length, 10);
  assert.equal(release.authorization.actor, "project-owner");
  assert.equal(release.ciEvidence.run.id, 99);
});

test("CI cannot pass with missing, skipped, duplicated, failed, foreign, or stale evidence", () => {
  for (const mutate of [
    (value) => { value.run.head_sha = "b".repeat(40); },
    (value) => { value.run.head_repository.full_name = "other/repo"; },
    (value) => { value.run.path = ".github/workflows/other.yml"; },
    (value) => { value.run.event = "pull_request"; },
    (value) => { value.run.head_branch = "other"; },
    (value) => { value.run.conclusion = "failure"; },
    (value) => { value.jobs.pop(); },
    (value) => { value.jobs.push(value.jobs[0]); },
    (value) => { value.jobs[2].conclusion = "skipped"; },
    (value) => { value.jobs[1].conclusion = "failure"; },
  ]) {
    const evidence = ciEvidence();
    mutate(evidence);
    assert.throws(() => verifyCiEvidence(evidence, source), /CI/u);
  }
});

test("release rejects changed manifest bytes and incomplete or vulnerable image inventory", () => {
  const imageManifestBytes = imageBytes();
  const release = createOwnerRelease({ source, ciEvidence: ciEvidence(), imageManifestBytes });
  assert.throws(() => verifyOwnerRelease(release, { expectedCommit: commit, repository, imageManifestBytes: Buffer.concat([imageManifestBytes, Buffer.from("\n")]) }), /image manifest hash mismatch/u);
  assert.throws(() => verifyOwnerRelease(release, { expectedCommit: "b".repeat(40), repository, imageManifestBytes }), /source commit mismatch/u);
  assert.throws(() => verifyOwnerRelease(release, { expectedCommit: commit, repository: "other/repo", imageManifestBytes }), /repository mismatch/u);
  for (const mutate of [
    (manifest) => { manifest.images.pop(); },
    (manifest) => { manifest.images[0].vulnerabilityReport.high = 1; },
    (manifest) => { manifest.images[0].sourceCommit = "b".repeat(40); },
    (manifest) => { manifest.images[0].imageRef = "ghcr.io/example/workbench-api:latest"; },
  ]) {
    const manifest = JSON.parse(imageManifestBytes);
    mutate(manifest);
    assert.throws(() => createOwnerRelease({ source, ciEvidence: ciEvidence(), imageManifestBytes: Buffer.from(JSON.stringify(manifest)) }));
  }
});

test("source requires owner approval and exact main workflow identity even after resealing", () => {
  const imageManifestBytes = imageBytes();
  for (const mutate of [
    (value) => { value.authorization.accepted = false; },
    (value) => { value.authorization.kind = "inferred"; },
    (value) => { value.workflow = ".github/workflows/other.yml"; },
    (value) => { value.ref = "refs/heads/untrusted"; },
    (value) => { value.version = "0.9.0"; },
  ]) {
    const invalid = structuredClone(source);
    mutate(invalid);
    assert.throws(() => createOwnerRelease({ source: invalid, ciEvidence: ciEvidence(), imageManifestBytes }));
  }
  const release = createOwnerRelease({ source, ciEvidence: ciEvidence(), imageManifestBytes });
  release.authorization.actor = "another-owner";
  assert.throws(() => verifyOwnerRelease(release, { expectedCommit: commit, repository, imageManifestBytes }), /payload hash mismatch/u);
  const { payloadSha256: _, ...payload } = release;
  release.payloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  // This pure semantic verifier is used only after Cosign verifies the bytes in the CLI.
  assert.equal(verifyOwnerRelease(release, { expectedCommit: commit, repository, imageManifestBytes }).images.length, 10);
});

test("archive source verification rejects changed bytes, path traversal, and symbolic files", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "owner-release-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = structuredClone(source);
  for (const name of Object.keys(document.sourceFiles)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), name);
    document.sourceFiles[name] = createHash("sha256").update(name).digest("hex");
  }
  assert.equal(verifySourceFiles(document, root), true);
  writeFileSync(path.join(root, "package.json"), "changed");
  assert.throws(() => verifySourceFiles(document, root), /hash mismatch/u);
  rmSync(path.join(root, "package.json"));
  symlinkSync(path.join(root, "package-lock.json"), path.join(root, "package.json"));
  assert.throws(() => verifySourceFiles(document, root), /symbolic links/u);
  document.sourceFiles["../outside"] = "e".repeat(64);
  assert.throws(() => verifySourceFiles(document, root), /invalid path/u);
});

test("workflow keeps publication manual, builds outside production, and only signs a complete tested release", () => {
  const workflow = YAML.parse(readFileSync(new URL(`../${OWNER_WORKFLOW}`, import.meta.url), "utf8"));
  assert.equal(assertOwnerReleaseWorkflow(workflow), true);
  for (const mutate of [
    (value) => { value.on.push = {}; },
    (value) => { value.on.workflow_dispatch.inputs.approve.default = true; },
    (value) => { value.jobs.source.if = "true"; },
    (value) => { value.jobs.release.needs = ["source", "images"]; },
    (value) => { value.jobs.images.strategy.matrix.include.pop(); },
    (value) => { value.jobs.images.steps.find((step) => step.id === "build").with.provenance = false; },
    (value) => { value.jobs.images.steps.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@")).with["exit-code"] = "0"; },
    (value) => { value.jobs.images.steps.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@")).with["ignore-unfixed"] = true; },
    (value) => { value.jobs.images.steps.find((step) => step.name === "Sign SLSA provenance and SPDX image attestations").run = "echo unsigned"; },
    (value) => { value.jobs.images.steps = value.jobs.images.steps.filter((step) => !step.run?.includes("owner-image-attestations.mjs verify")); },
    (value) => { value.jobs.release.steps.find((step) => step.name === "Assemble exact candidate release package").run = "echo missing proofs"; },
  ]) {
    const invalid = structuredClone(workflow);
    mutate(invalid);
    assert.throws(() => assertOwnerReleaseWorkflow(invalid));
  }
});

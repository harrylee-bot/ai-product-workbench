#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { canonicalJson } from "./evidence-ledger.mjs";
import {
  assembleProductionImageManifest,
  assertPinnedWorkflowActions,
  loadProductionImageInventory,
  verifyCosignManifestBlob,
  verifyLocalProductionImageBindings,
  verifyProductionImageManifest,
  verifyProductionImageSignatureBundles,
} from "./production-image-inventory.mjs";
import { readDeploymentEnv } from "./workbench-origin-manifest.mjs";

export const OWNER_RELEASE_SCHEMA = "workbench.owner-release.v1";
export const OWNER_WORKFLOW = ".github/workflows/workbench-owner-release.yml";
export const REQUIRED_CI_JOBS = Object.freeze([
  "Verify G0-G2 release chain",
  "Contracts, architecture, tests, and build",
  "Real-stack browser / controlled-local-deerflow",
  "Compose, gateways, and Quartz behavior",
]);
const COMMIT = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const REQUIRED_SOURCE_FILES = ["package.json", "package-lock.json", "scripts/owner-release.mjs", "scripts/production-image-inventory.mjs", "deploy/workbench-owner-deploy.py"];

export function verifyCiEvidence(evidence, { repository, sourceCommit }) {
  const run = evidence?.run;
  assert(run?.head_sha === sourceCommit, "CI source commit mismatch");
  assert(run?.head_repository?.full_name === repository, "CI repository mismatch");
  assert(run?.path === ".github/workflows/workbench-ci.yml", "CI workflow mismatch");
  assert(run?.head_branch === "main" && run.event === "push", "CI must be a main push run");
  assert(run?.status === "completed" && run.conclusion === "success", "CI has not passed");
  assert(Number.isSafeInteger(run.id) && run.id > 0, "CI run ID is invalid");
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "CI run attempt is invalid");
  assert(Array.isArray(evidence.jobs), "CI jobs are required");
  for (const name of REQUIRED_CI_JOBS) {
    const matches = evidence.jobs.filter((job) => job.name === name);
    assert(matches.length === 1, `CI must contain exactly one ${name} job`);
    assert(matches[0].status === "completed" && matches[0].conclusion === "success", `CI job did not pass: ${name}`);
    assert(Number.isSafeInteger(matches[0].id) && matches[0].id > 0, `CI job ID is invalid: ${name}`);
  }
  return true;
}

export function createOwnerRelease({ source, ciEvidence, imageManifestBytes }) {
  verifySource(source);
  verifyCiEvidence(ciEvidence, source);
  const imageManifest = JSON.parse(imageManifestBytes.toString("utf8"));
  verifyProductionImageManifest({ manifest: imageManifest, expectedCommit: source.sourceCommit });
  const payload = {
    schemaVersion: OWNER_RELEASE_SCHEMA,
    status: "PASS",
    ...source,
    ciEvidence,
    imageManifestSha256: sha256(imageManifestBytes),
  };
  return { ...payload, payloadSha256: sha256(canonicalJson(payload)) };
}

export function verifyOwnerRelease(document, { expectedCommit, repository, imageManifestBytes }) {
  assert(document?.schemaVersion === OWNER_RELEASE_SCHEMA && document.status === "PASS", "owner release must be PASS");
  const { payloadSha256, ...payload } = document;
  assert(HASH.test(payloadSha256 ?? "") && payloadSha256 === sha256(canonicalJson(payload)), "owner release payload hash mismatch");
  verifySource(document);
  assert(COMMIT.test(expectedCommit ?? "") && document.sourceCommit === expectedCommit, "owner release source commit mismatch");
  assert(document.repository === repository, "owner release repository mismatch");
  verifyCiEvidence(document.ciEvidence, document);
  assert(document.imageManifestSha256 === sha256(imageManifestBytes), "owner release image manifest hash mismatch");
  const manifest = JSON.parse(imageManifestBytes.toString("utf8"));
  verifyProductionImageManifest({ manifest, expectedCommit });
  return manifest;
}

function verifySource(source) {
  assert(source?.version === "1.0.0", "owner release version must be 1.0.0");
  assert(COMMIT.test(source.sourceCommit ?? ""), "owner release source commit is invalid");
  assert(COMMIT.test(source.sourceTree ?? ""), "owner release source tree is invalid");
  assert(REPOSITORY.test(source.repository ?? ""), "owner release repository is invalid");
  assert(source.workflow === OWNER_WORKFLOW && source.ref === "refs/heads/main", "owner release workflow must be main");
  assert(source.authorization?.kind === "project-owner-workflow-dispatch", "project owner dispatch is required");
  assert(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/u.test(source.authorization.actor ?? ""), "dispatch actor is invalid");
  assert(source.authorization.accepted === true, "project owner release authorization is required");
  assert(Number.isSafeInteger(source.workflowRun?.id) && source.workflowRun.id > 0, "owner workflow run ID is invalid");
  assert(Number.isSafeInteger(source.workflowRun?.attempt) && source.workflowRun.attempt > 0, "owner workflow attempt is invalid");
  assert(source.sourceFiles && typeof source.sourceFiles === "object" && !Array.isArray(source.sourceFiles), "signed source file inventory is required");
  for (const name of REQUIRED_SOURCE_FILES) assert(HASH.test(source.sourceFiles[name] ?? ""), `signed source inventory is missing ${name}`);
  for (const [name, hash] of Object.entries(source.sourceFiles)) {
    assert(isSourcePath(name) && HASH.test(hash), "signed source inventory contains an invalid path or digest");
  }
}

function isSourcePath(name) {
  return typeof name === "string" && name.length > 0 && !path.isAbsolute(name)
    && !name.includes("\\") && !name.includes("\0")
    && name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function verifySourceFiles(source, sourceRoot) {
  verifySource(source);
  const root = realpathSync(sourceRoot);
  for (const [name, hash] of Object.entries(source.sourceFiles)) {
    const filename = path.join(root, name);
    const stat = lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink() && realpathSync(filename) === filename, `source file must be regular and cannot traverse symbolic links: ${name}`);
    assert(sha256(readFileSync(filename)) === hash, `source file hash mismatch: ${name}`);
  }
  return true;
}

export function assertOwnerReleaseWorkflow(workflow) {
  assertPinnedWorkflowActions(workflow);
  assert(Object.keys(workflow.on).join() === "workflow_dispatch", "owner release must only allow explicit dispatch");
  assert(workflow.on.workflow_dispatch.inputs?.approve?.type === "boolean"
    && workflow.on.workflow_dispatch.inputs.approve.default === false, "owner approval must default to false");
  assert(workflow.concurrency?.["cancel-in-progress"] === false, "owner releases must not be cancelled by newer runs");
  const guard = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.approve == true";
  assert(workflow.jobs?.source?.if === guard, "owner source must enforce explicit main approval");
  assert(JSON.stringify(workflow.jobs?.release?.needs?.toSorted()) === JSON.stringify(["ci", "images", "source"]), "final release must wait for CI and all images");
  assert(workflow.permissions?.contents === "read" && !workflow.permissions?.["id-token"], "global release permissions must be read-only");
  const ids = workflow.jobs?.images?.strategy?.matrix?.include?.map((image) => image.name).sort();
  assert(JSON.stringify(ids) === JSON.stringify(loadProductionImageInventory().candidateImages.map((image) => image.id)), "owner image matrix must cover all ten images");
  assert(workflow.jobs?.images?.needs?.includes("source") && workflow.jobs?.ci?.needs?.includes("source"), "CI and images must bind the checked source");
  for (const id of ["images", "release"]) {
    const job = workflow.jobs[id];
    assert(job.permissions?.["id-token"] === "write", `${id} must sign with GitHub OIDC`);
    assert(job.steps.some((step) => step.env?.CERTIFICATE_IDENTITY === "https://github.com/${{ github.repository }}/.github/workflows/workbench-owner-release.yml@refs/heads/main"), `${id} must pin the owner workflow signing identity`);
  }
  const build = workflow.jobs.images.steps.find((step) => step.id === "build");
  assert(build?.with?.push === true && build.with.load === false && build.with.provenance === "mode=max" && build.with.sbom === true, "owner images must preserve provenance and SBOM");
  const scan = workflow.jobs.images.steps.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@"));
  assert(scan?.with?.["exit-code"] === "1" && scan.with.severity === "CRITICAL,HIGH", "owner images must preserve vulnerability blocking");
  return true;
}

function prepareSource() {
  const sourceCommit = process.env.GITHUB_SHA;
  assert(sourceCommit === process.env.OWNER_RELEASE_COMMIT, "requested commit must equal the main workflow commit");
  assert(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() === sourceCommit, "checkout commit mismatch");
  execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: ["ignore", "ignore", "pipe"] });
  const filenames = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const sourceFiles = Object.fromEntries(filenames.map((name) => {
    assert(isSourcePath(name) && lstatSync(name).isFile() && !lstatSync(name).isSymbolicLink(), `source inventory cannot include symbolic or external files: ${name}`);
    return [name, sha256(readFileSync(name))];
  }));
  const source = {
    version: "1.0.0",
    repository: process.env.GITHUB_REPOSITORY,
    sourceCommit,
    sourceTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    sourceFiles,
    workflow: OWNER_WORKFLOW,
    ref: process.env.GITHUB_REF,
    authorization: {
      kind: "project-owner-workflow-dispatch",
      actor: process.env.GITHUB_ACTOR,
      accepted: process.env.OWNER_RELEASE_APPROVED === "true" && process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
    },
    workflowRun: { id: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
  };
  verifySource(source);
  assert(JSON.parse(readFileSync("package.json")).version === source.version, "package version must match owner release");
  return source;
}

function githubJson(endpoint) {
  return JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }));
}

async function waitForCi({ repository, commit, output, timeoutMs = 90 * 60_000 }) {
  assert(REPOSITORY.test(repository ?? "") && COMMIT.test(commit ?? ""), "CI repository and commit are required");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = githubJson(`repos/${repository}/actions/workflows/workbench-ci.yml/runs?head_sha=${commit}&event=push&per_page=100`).workflow_runs;
    const relevant = runs.filter((run) => run.head_sha === commit && run.head_branch === "main");
    const run = relevant.find((entry) => entry.status === "completed" && entry.conclusion === "success");
    if (run) {
      const jobs = githubJson(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
      const evidence = { run, jobs };
      verifyCiEvidence(evidence, { repository, sourceCommit: commit });
      writeJson(output, evidence);
      console.log(`Exact candidate CI passed: ${run.id} attempt ${run.run_attempt}`);
      return;
    }
    if (relevant.length > 0 && relevant.every((entry) => entry.status === "completed")) {
      throw new Error(`Exact candidate CI failed: ${relevant.map((entry) => `${entry.id}:${entry.conclusion}`).join(", ")}`);
    }
    console.log(`Waiting for CI of ${commit}; candidate images are built separately.`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new Error("exact candidate CI wait timed out");
}

function assemble({ source: sourcePath, ci, records, output }) {
  const source = JSON.parse(readFileSync(sourcePath));
  const ciEvidence = JSON.parse(readFileSync(ci));
  verifySource(source);
  verifyCiEvidence(ciEvidence, source);
  const imageRecords = readdirSync(records).filter((name) => /^image-record-[a-z-]+\.json$/u.test(name)).map((name) => JSON.parse(readFileSync(path.join(records, name))));
  const manifest = assembleProductionImageManifest({ records: imageRecords, expectedCommit: source.sourceCommit });
  mkdirSync(output, { recursive: true });
  const imageManifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(output, "production-image-manifest.json"), imageManifestBytes);
  writeJson(path.join(output, "owner-release.json"), createOwnerRelease({ source, ciEvidence, imageManifestBytes }));
}

function verifyFiles(args) {
  const identityMatch = args["certificate-identity"]?.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/\.github\/workflows\/workbench-owner-release\.yml@refs\/heads\/main$/u);
  assert(identityMatch, "certificate identity must pin the owner main workflow");
  for (const [manifestPath, bundlePath] of [[args.manifest, args.bundle], [args["image-manifest"], args["image-bundle"]]]) {
    verifyCosignManifestBlob({ manifestPath, bundlePath, certificateIdentity: args["certificate-identity"], certificateOidcIssuer: OIDC_ISSUER });
  }
  const document = JSON.parse(readFileSync(args.manifest));
  const manifest = verifyOwnerRelease(document, {
    expectedCommit: args["expected-commit"],
    repository: identityMatch[1],
    imageManifestBytes: readFileSync(args["image-manifest"]),
  });
  if (args["source-root"]) verifySourceFiles(document, args["source-root"]);
  verifyProductionImageSignatureBundles({
    manifest,
    signatureBundleRoot: args["signature-root"] ?? path.dirname(args.manifest),
    certificateIdentity: args["certificate-identity"],
    certificateOidcIssuer: OIDC_ISSUER,
    expectedCommit: document.sourceCommit,
  });
  if (args["env-file"]) {
    verifyProductionImageManifest({ manifest, expectedCommit: document.sourceCommit, deploymentEnvironment: readDeploymentEnv(readFileSync(args["env-file"], "utf8")) });
  }
  if (args["build-env-file"]) {
    const deploymentEnvironment = readDeploymentEnv(readFileSync(args["build-env-file"], "utf8"));
    const byId = new Map(manifest.images.map((record) => [record.id, record]));
    for (const definition of loadProductionImageInventory().candidateImages) {
      deploymentEnvironment.set(definition.imageEnvironment, byId.get(definition.id).imageRef);
    }
    verifyProductionImageManifest({ manifest, expectedCommit: document.sourceCommit, deploymentEnvironment });
  }
  if (args["inspect-local"] === "true") verifyLocalProductionImageBindings({ manifest, expectedCommit: document.sourceCommit });
  const records = new Map(manifest.images.map((image) => [image.id, image]));
  const images = loadProductionImageInventory().candidateImages.map((definition) => ({
    id: definition.id,
    composeFile: definition.composeFile,
    composeService: definition.composeService,
    imageEnvironment: definition.imageEnvironment,
    imageRef: records.get(definition.id).imageRef,
    digest: records.get(definition.id).digest,
  }));
  return { status: "PASS", version: document.version, sourceCommit: document.sourceCommit, ciRunId: document.ciEvidence.run.id, workflowRun: document.workflowRun, images };
}

function writeJson(filename, value) {
  mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const [command, ...values] = argv;
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    assert(key.startsWith("--") && values[index + 1] !== undefined && !Object.hasOwn(args, key.slice(2)), "invalid owner release arguments");
    args[key.slice(2)] = values[index + 1];
  }
  return { command, args };
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "source") writeJson(args.output, prepareSource());
  else if (command === "wait-ci") await waitForCi(args);
  else if (command === "assemble") assemble(args);
  else if (command === "verify") process.stdout.write(`${JSON.stringify(verifyFiles(args), null, 2)}\n`);
  else if (command === "contract") {
    assertOwnerReleaseWorkflow(YAML.parse(readFileSync(new URL(`../${OWNER_WORKFLOW}`, import.meta.url), "utf8")));
    console.log("Owner release workflow contract passed");
  } else throw new Error("Usage: owner-release.mjs source|wait-ci|assemble|verify|contract [--option value]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { console.error(`owner release: ${error.message}`); process.exitCode = 1; });
}

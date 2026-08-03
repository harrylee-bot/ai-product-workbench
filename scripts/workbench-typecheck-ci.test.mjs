import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import YAML from "yaml";

import {
  captureGitSourceSnapshot,
  createBaselineCleanGate,
  createNodeOptions,
  discoverWorkspaceInventory,
  parseConfiguration,
  parsePeakRssKiB,
} from "./workbench-typecheck-ci.mjs";
import {
  evaluateWorkbenchCiGate,
  parseWorkbenchCiGateEnvironment,
} from "./workbench-ci-required-gate.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const typecheckScript = fileURLToPath(new URL("./workbench-typecheck-ci.mjs", import.meta.url));

test("defaults to two 4096 MiB passes and validates configured memory", () => {
  assert.deepEqual(
    parseConfiguration({ argv: [], env: {}, memoryLimitMiB: 16 * 1024 }),
    { heapMiB: 4096, passes: 2, requireCleanBaseline: false, minimumMemoryMiB: null },
  );
  assert.deepEqual(
    parseConfiguration({
      argv: ["--passes=1"],
      env: { WORKBENCH_TYPECHECK_HEAP_MIB: "6144", WORKBENCH_TYPECHECK_PASSES: "3" },
      memoryLimitMiB: 16 * 1024,
    }),
    { heapMiB: 6144, passes: 1, requireCleanBaseline: false, minimumMemoryMiB: null },
  );
  assert.equal(
    parseConfiguration({
      argv: [],
      env: { CI: "true" },
      memoryLimitMiB: 16 * 1024,
      platform: "linux",
    }).requireCleanBaseline,
    true,
  );
  assert.equal(
    parseConfiguration({
      argv: [],
      env: { CI: "true" },
      memoryLimitMiB: 16 * 1024,
      platform: "linux",
    }).minimumMemoryMiB,
    15 * 1024,
  );
  assert.throws(
    () => parseConfiguration({
      argv: [],
      env: { CI: "true", WORKBENCH_TYPECHECK_MIN_MEMORY_MIB: "7168" },
      memoryLimitMiB: 7_942,
      platform: "linux",
    }),
    /must be at least 15360 MiB/u,
  );
  assert.equal(
    parseConfiguration({
      argv: [],
      env: { CI: "true", WORKBENCH_TYPECHECK_REQUIRE_CLEAN: "false" },
      memoryLimitMiB: 16 * 1024,
      platform: "linux",
    }).requireCleanBaseline,
    true,
  );
  assert.throws(
    () => parseConfiguration({
      argv: [],
      env: { CI: "true" },
      memoryLimitMiB: 16 * 1024,
      platform: "darwin",
    }),
    /requires Linux/u,
  );
  assert.throws(
    () => parseConfiguration({
      argv: [],
      env: { CI: "true" },
      memoryLimitMiB: 8 * 1024,
      platform: "linux",
    }),
    /requires at least 15360 MiB/u,
  );
  assert.throws(
    () => parseConfiguration({
      argv: [],
      env: { WORKBENCH_TYPECHECK_HEAP_MIB: "16384" },
      memoryLimitMiB: 16 * 1024,
    }),
    /must be below available memory/u,
  );
  assert.throws(
    () => parseConfiguration({ argv: ["--unknown"], env: {}, memoryLimitMiB: 16 * 1024 }),
    /Unknown typecheck option/u,
  );
});

test("preserves existing Node options while applying the configured heap", () => {
  assert.equal(
    createNodeOptions("--enable-source-maps", 4096),
    "--enable-source-maps --max-old-space-size=4096",
  );
  assert.equal(createNodeOptions(undefined, 4096), "--max-old-space-size=4096");
});

test("fails closed on a dirty CI baseline without blocking local drift checks", () => {
  assert.equal(createBaselineCleanGate({ dirty: true, required: true }).status, "FAIL");
  assert.equal(createBaselineCleanGate({ dirty: true, required: false }).status, "PASS");
  assert.equal(createBaselineCleanGate({ dirty: false, required: true }).status, "PASS");
});

test("parses GNU and Darwin peak RSS evidence into KiB", () => {
  assert.equal(parsePeakRssKiB("Maximum resident set size (kbytes): 123456\n", "linux"), 123456);
  assert.equal(parsePeakRssKiB("  10485760  maximum resident set size\n", "darwin"), 10240);
  assert.equal(parsePeakRssKiB("", "linux"), null);
});

test("derives the typecheck inventory from npm workspace package manifests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "package.json"), {
    private: true,
    workspaces: ["packages/*", "!packages/excluded"],
  });
  await writeJson(path.join(root, "packages", "typed", "package.json"), {
    name: "@fixture/typed",
    scripts: { typecheck: "tsc --noEmit" },
  });
  await writeJson(path.join(root, "packages", "untyped", "package.json"), {
    name: "@fixture/untyped",
  });
  await writeJson(path.join(root, "packages", "excluded", "package.json"), {
    name: "@fixture/excluded",
    scripts: { typecheck: "false" },
  });

  const inventory = await discoverWorkspaceInventory(root);
  assert.deepEqual(inventory.workspaces.map((workspace) => workspace.name), [
    "@fixture/typed",
    "@fixture/untyped",
  ]);
  assert.deepEqual(inventory.typecheckWorkspaces.map((workspace) => workspace.name), ["@fixture/typed"]);
});

test("the repository inventory includes every current typecheck workspace", async () => {
  const inventory = await discoverWorkspaceInventory(repoRoot);
  assert.equal(inventory.workspaces.length, 16);
  assert.equal(inventory.typecheckWorkspaces.length, 15);
  assert(inventory.typecheckWorkspaces.some(({ name }) => name === "@workbench/workbench-contracts"));
  assert(inventory.typecheckWorkspaces.some(({ name }) => name === "@workbench/workbench-canvas-tools"));
  assert.deepEqual(
    inventory.workspaces.filter(({ typecheckCommand }) => typecheckCommand === null).map(({ name }) => name),
    ["@workbench/workbench-db"],
  );
});

test("source snapshots ignore ignored outputs and detect Git-visible drift", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), "generated/\n");
  await writeFile(path.join(root, "source.txt"), "stable\n");
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Typecheck Test", "-c", "user.email=typecheck@example.invalid", "commit", "--quiet", "-m", "fixture"]);

  const baseline = await captureGitSourceSnapshot(root);
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(path.join(root, "generated", "output.txt"), "ignored\n");
  assert.equal((await captureGitSourceSnapshot(root)).digest, baseline.digest);

  await writeFile(path.join(root, "source.txt"), "drifted\n");
  assert.notEqual((await captureGitSourceSnapshot(root)).digest, baseline.digest);
});

test("the aggregate continues after a workspace failure and reports every target", {
  skip: process.platform === "win32",
}, async (t) => {
  const outerRoot = await mkdtemp(path.join(tmpdir(), "workbench-typecheck-cli-"));
  t.after(() => rm(outerRoot, { recursive: true, force: true }));
  const fixtureRoot = path.join(outerRoot, "repo");
  const binRoot = path.join(outerRoot, "bin");
  const npmLog = path.join(outerRoot, "npm.log");
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await writeJson(path.join(fixtureRoot, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
    scripts: { "workbench:prepare": "fixture" },
  });
  await writeJson(path.join(fixtureRoot, "packages", "fail", "package.json"), {
    name: "@fixture/fail",
    scripts: { typecheck: "fixture" },
  });
  await writeJson(path.join(fixtureRoot, "packages", "pass", "package.json"), {
    name: "@fixture/pass",
    scripts: { typecheck: "fixture" },
  });
  const fakeNpm = path.join(binRoot, "npm");
  await writeFile(fakeNpm, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$NPM_LOG\"",
    "sleep 0.1",
    "case \"$*\" in",
    "  *'@fixture/fail'*) exit 7 ;;",
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(fakeNpm, 0o755);
  await git(fixtureRoot, ["init", "--quiet"]);
  await git(fixtureRoot, ["add", "."]);
  await git(fixtureRoot, ["-c", "user.name=Typecheck Test", "-c", "user.email=typecheck@example.invalid", "commit", "--quiet", "-m", "fixture"]);

  let failure;
  try {
    await execFileAsync(process.execPath, [typecheckScript, "--passes=1"], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        CI: "false",
        NPM_LOG: npmLog,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH}`,
        WORKBENCH_TYPECHECK_HEAP_MIB: "128",
      },
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure, "the aggregate must fail when one workspace fails");
  assert.equal(failure.code, 1);
  const events = String(failure.stdout)
    .split("\n")
    .filter((line) => line.startsWith("TYPECHECK_RESULT "))
    .map((line) => JSON.parse(line.slice("TYPECHECK_RESULT ".length)));
  assert.deepEqual(events.map(({ target }) => target), [
    "workbench:prepare",
    "@fixture/fail",
    "@fixture/pass",
  ]);
  assert.equal(events.find(({ target }) => target === "@fixture/fail").exitCode, 7);
  assert.equal(events.find(({ target }) => target === "@fixture/pass").status, "PASS");
  assert(events.every(({ peakRssKiB }) => Number.isInteger(peakRssKiB) && peakRssKiB > 0));
  assert.match(String(failure.stdout), /TYPECHECK_SUMMARY .*"commandsFailed":1/u);
  assert.deepEqual((await readFile(npmLog, "utf8")).trim().split("\n"), [
    "run workbench:prepare",
    "--workspace @fixture/fail run typecheck",
    "--workspace @fixture/pass run typecheck",
  ]);
});

test("required CI gate accepts only event-appropriate successful jobs", () => {
  assert.equal(evaluateWorkbenchCiGate({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    internalPullRequest: true,
    changedImageCount: "0",
    jobs: ciJobResults({ "pr-production-image-selection": "success" }),
  }).status, "PASS");

  assert.equal(evaluateWorkbenchCiGate({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    internalPullRequest: true,
    changedImageCount: "3",
    jobs: ciJobResults({
      "pr-production-image-selection": "success",
      "pr-production-images": "success",
    }),
  }).status, "PASS");

  assert.equal(evaluateWorkbenchCiGate({
    eventName: "push",
    ref: "refs/heads/main",
    internalPullRequest: false,
    changedImageCount: "",
    jobs: ciJobResults(),
  }).status, "PASS");

  assert.equal(evaluateWorkbenchCiGate({
    eventName: "push",
    ref: "refs/heads/production",
    internalPullRequest: false,
    changedImageCount: "",
    jobs: ciJobResults({
      "release-chain-signing": "success",
      "production-images": "success",
      "image-evidence": "success",
      "deployment-config-evidence": "success",
    }),
  }).status, "PASS");
});

test("required CI gate never converts missing execution or fork policy into PASS", () => {
  const missingTypecheck = evaluateWorkbenchCiGate({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    internalPullRequest: true,
    changedImageCount: "0",
    jobs: ciJobResults({
      "typecheck-linux-16g": "skipped",
      "pr-production-image-selection": "success",
    }),
  });
  assert.equal(missingTypecheck.status, "BLOCKED");
  assert.match(missingTypecheck.findings[0].message, /WORKBENCH_TYPECHECK_RUNNER/u);

  const skippedImages = evaluateWorkbenchCiGate({
    eventName: "pull_request",
    ref: "refs/pull/42/merge",
    internalPullRequest: true,
    changedImageCount: "2",
    jobs: ciJobResults({ "pr-production-image-selection": "success" }),
  });
  assert.equal(skippedImages.status, "BLOCKED");
  assert(skippedImages.findings.some(({ message }) => message.includes("pr-production-images")));

  const failedRealStack = evaluateWorkbenchCiGate({
    eventName: "push",
    ref: "refs/heads/main",
    internalPullRequest: false,
    changedImageCount: "",
    jobs: ciJobResults({ "real-stack-browser": "failure" }),
  });
  assert.equal(failedRealStack.status, "FAIL");

  const fork = evaluateWorkbenchCiGate({
    eventName: "pull_request",
    ref: "refs/pull/43/merge",
    internalPullRequest: false,
    changedImageCount: "",
    jobs: ciJobResults({ "pr-production-images-fork-policy": "failure" }),
  });
  assert.equal(fork.status, "BLOCKED");
  assert(fork.findings.some(({ code }) => code === "FORK_PR_REQUIRES_TRUSTED_RERUN"));
});

test("required CI gate parses only structured terminal needs results", () => {
  const parsed = parseWorkbenchCiGateEnvironment({
    WORKBENCH_CI_EVENT_NAME: "push",
    WORKBENCH_CI_REF: "refs/heads/main",
    WORKBENCH_CI_PR_IS_INTERNAL: "false",
    WORKBENCH_CI_PR_CHANGED_IMAGE_COUNT: "",
    WORKBENCH_CI_JOB_RESULTS_JSON: JSON.stringify(Object.fromEntries(
      Object.entries(ciJobResults()).map(([jobId, result]) => [jobId, { result, outputs: {} }]),
    )),
  });
  assert.equal(parsed.jobs.quality, "success");
  assert.equal(parsed.internalPullRequest, false);
  assert.throws(
    () => parseWorkbenchCiGateEnvironment({ WORKBENCH_CI_JOB_RESULTS_JSON: "not-json" }),
    /must be valid JSON/u,
  );
});

test("root typecheck scripts share the dynamic orchestrator", async () => {
  const packageData = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageData.scripts.typecheck, "node scripts/workbench-typecheck-ci.mjs --passes=1");
  assert.equal(packageData.scripts["typecheck:ci"], "node scripts/workbench-typecheck-ci.mjs");
  assert.match(packageData.scripts["dev:workbench:test"], /workbench-typecheck-ci\.test\.mjs/u);

  const workflow = await readFile(path.join(repoRoot, ".github/workflows/workbench-ci.yml"), "utf8");
  assert.match(workflow, /WORKBENCH_TYPECHECK_MIN_MEMORY_MIB: 15360/u);
  assert.match(workflow, /name: Upload Linux typecheck evidence/u);
  const parsedWorkflow = YAML.parse(workflow);
  const linuxTypecheck = parsedWorkflow.jobs["typecheck-linux-16g"];
  const quality = parsedWorkflow.jobs.quality;
  const requiredCi = parsedWorkflow.jobs["required-ci"];
  assert.equal(
    parsedWorkflow.env.WORKBENCH_CANDIDATE_SHA,
    "${{ github.event.pull_request.head.sha || github.sha }}",
  );
  assert.equal(quality.steps.find((step) => step.name === "Checkout").with.ref, "${{ env.WORKBENCH_CANDIDATE_SHA }}");
  assert.deepEqual(linuxTypecheck.needs, ["candidate-source-policy", "release-chain"]);
  assert.equal(
    linuxTypecheck.if,
    "${{ vars.WORKBENCH_TYPECHECK_RUNNER != '' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}",
  );
  assert.equal(
    linuxTypecheck["runs-on"],
    "${{ vars.WORKBENCH_TYPECHECK_RUNNER }}",
  );
  assert.equal(linuxTypecheck.env.WORKBENCH_TYPECHECK_MIN_MEMORY_MIB, 15360);
  assert.equal(linuxTypecheck.env.NODE_OPTIONS, "--max-old-space-size=4096");
  const linuxTypecheckRun = linuxTypecheck.steps.find(
    (step) => step.name === "Check types twice on 16 GiB Linux",
  ).run;
  assert.match(linuxTypecheckRun, /npm run typecheck:ci 2>&1 \| tee/u);
  assert.match(linuxTypecheckRun, /typecheck_status="\$\{PIPESTATUS\[0\]\}"/u);
  assert.equal(
    linuxTypecheck.steps.find((step) => step.name === "Checkout").with.ref,
    "${{ env.WORKBENCH_CANDIDATE_SHA }}",
  );
  assert.equal(quality.env.NODE_OPTIONS, "--max-old-space-size=4096");
  assert.equal(quality.env.WORKBENCH_TYPECHECK_MIN_MEMORY_MIB, undefined);
  assert.match(
    linuxTypecheck.steps.find((step) => step.name === "Upload Linux typecheck evidence").with.name,
    /env\.WORKBENCH_CANDIDATE_SHA/u,
  );
  const hostedTypecheck = quality.steps.find(
    (step) => step.name === "Check all workspace types on hosted runner",
  );
  assert.equal(hostedTypecheck.run, "npm run typecheck");
  assert.equal(hostedTypecheck.env.CI, "false");
  assert.equal(quality.steps.find((step) => step.name === "Check Workbench lint").run, "npm run lint:workbench");
  assert.equal(quality.steps.find((step) => step.name === "Run server and worker tests").run, "npm test");
  assert.equal(quality.steps.find((step) => step.name === "Build production artifacts").run, "npm run build");
  assert(
    parsedWorkflow.jobs["production-images"].needs.includes("typecheck-linux-16g"),
    "production image publication must depend on the 16 GiB Linux typecheck",
  );
  assert.equal(requiredCi.if, "always()");
  assert.deepEqual(requiredCi.needs, [
    "candidate-source-policy",
    "release-chain",
    "release-chain-signing",
    "typecheck-linux-16g",
    "quality",
    "real-stack-browser",
    "deployment-config",
    "pr-production-image-selection",
    "pr-production-images",
    "pr-production-images-fork-policy",
    "production-images",
    "image-evidence",
    "deployment-config-evidence",
  ]);
  const requiredGateStep = requiredCi.steps.find(
    (step) => step.name === "Evaluate event-aware required results",
  );
  assert.equal(requiredGateStep.run, "node scripts/workbench-ci-required-gate.mjs");
  assert.equal(requiredGateStep.env.WORKBENCH_CI_JOB_RESULTS_JSON, "${{ toJSON(needs) }}");
  for (const stepName of ["Check Workbench lint", "Run server and worker tests", "Build production artifacts"]) {
    assert.equal(quality.steps.find((step) => step.name === stepName).env?.NODE_OPTIONS, undefined);
  }
});

function ciJobResults(overrides = {}) {
  return {
    "candidate-source-policy": "success",
    "release-chain": "success",
    "release-chain-signing": "skipped",
    "typecheck-linux-16g": "success",
    quality: "success",
    "real-stack-browser": "success",
    "deployment-config": "success",
    "pr-production-image-selection": "skipped",
    "pr-production-images": "skipped",
    "pr-production-images-fork-policy": "skipped",
    "production-images": "skipped",
    "image-evidence": "skipped",
    "deployment-config-evidence": "skipped",
    ...overrides,
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

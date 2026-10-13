import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { assertLocalRunnerWorkflow } from "./workbench-local-runner-workflow.mjs";
import { REQUIRED_CI_JOBS } from "./owner-release.mjs";

const workflows = [false, true].map((owner) => ({
  owner,
  workflow: YAML.parse(readFileSync(new URL(owner ? "../.github/workflows/workbench-owner-release.yml" : "../.github/workflows/workbench-ci.yml", import.meta.url), "utf8")),
}));
const imageJob = (workflow, owner) => workflow.jobs[owner ? "images" : "production-images"];
const setup = (workflow, owner) => imageJob(workflow, owner).steps.find((step) => step.uses?.startsWith("docker/setup-buildx-action@"));
const build = (workflow, owner) => imageJob(workflow, owner).steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));

test("both workflows pin the isolated ARM64 runner and production AMD64 contract", () => {
  for (const { workflow, owner } of workflows) assert.equal(assertLocalRunnerWorkflow(workflow, { owner }), true);
});

const mutations = [
  ["hosted fallback", (w, o) => { imageJob(w, o)["runs-on"] = "ubuntu-latest"; }],
  ["production runner label", (w, o) => { imageJob(w, o)["runs-on"] = ["self-hosted", "workbench-typecheck-16g"]; }],
  ["any job escape", (w) => { Object.values(w.jobs)[0]["runs-on"].pop(); }],
  ["parallel image matrix", (w, o) => { imageJob(w, o).strategy["max-parallel"] = 2; }],
  ["missing builder name", (w, o) => { delete setup(w, o).with.name; }],
  ["remote daemon", (w, o) => { setup(w, o).with.endpoint = "ssh://production"; }],
  ["memory cap removed", (w, o) => { setup(w, o).with["driver-opts"] = "cpu-quota=200000"; }],
  ["memory swap reopened", (w, o) => { setup(w, o).with["driver-opts"] = setup(w, o).with["driver-opts"].replace("memory-swap=4294967296", "memory-swap=-1"); }],
  ["foreign build proxy", (w, o) => { setup(w, o).with["driver-opts"] = setup(w, o).with["driver-opts"].replace("env.http_proxy=${{ env.WORKBENCH_BUILD_PROXY }}", "env.http_proxy=http://foreign.invalid"); }],
  ["parallel policy removed", (w, o) => { delete setup(w, o).with["buildkitd-config"]; }],
  ["insecure build network", (w, o) => { setup(w, o).with["buildkitd-flags"] = "--allow-insecure-entitlement network.host"; }],
  ["native ARM image", (w, o) => { build(w, o).with.platforms = "linux/arm64"; }],
  ["implicit platform", (w, o) => { delete build(w, o).with.platforms; }],
  ["build host entitlement", (w, o) => { build(w, o).with.allow = "network.host"; }],
  ["build privileged entitlement", (w, o) => { build(w, o).with.allow = "security.insecure"; }],
  ["build host network", (w, o) => { build(w, o).with.network = "host"; }],
  ["registry build cache", (w, o) => { build(w, o).with["cache-to"] = "type=registry,ref=some/cache"; }],
  ["automatic Docker artifact", (w) => { w.env.DOCKER_BUILD_RECORD_UPLOAD = "true"; }],
  ["cloud cache action", (w, o) => { imageJob(w, o).steps.splice(2, 0, { uses: "actions/cache@abc" }); }],
  ["missing identity guard", (w, o) => { imageJob(w, o).steps.splice(1, 1); }],
  ["unconditional cleanup removed", (w, o) => { delete imageJob(w, o).steps.at(-1).if; }],
  ["unchecked builder", (w, o) => { imageJob(w, o).steps = imageJob(w, o).steps.filter((step) => !step.run?.endsWith(" verify-builder")); }],
  ["missing compatibility test", (w, o) => { imageJob(w, o).steps = imageJob(w, o).steps.filter((step) => !step.run?.includes(" image-smoke ")); }],
  ["persistent checkout token", (w, o) => { imageJob(w, o).steps[0].with["persist-credentials"] = true; }],
  ["native SBOM scan", (w, o) => { delete imageJob(w, o).steps.find((step) => step.uses?.startsWith("anchore/sbom-action@")).env.SYFT_PLATFORM; }],
  ["cached vulnerability scan", (w, o) => { imageJob(w, o).steps.find((step) => step.uses?.startsWith("aquasecurity/trivy-action@")).with.cache = true; }],
];
for (const [name, mutate] of mutations) {
  test("reject " + name, () => {
    for (const { workflow, owner } of workflows) {
      const invalid = structuredClone(workflow);
      mutate(invalid, owner);
      assert.throws(() => assertLocalRunnerWorkflow(invalid, { owner }));
    }
  });
}
test("reject fork PR and shared service port", () => {
  const ci = workflows[0].workflow;
  for (const mutate of [
    (w) => { w.jobs.quality.if = "github.event_name == 'pull_request'"; },
    (w) => { w.jobs["pr-production-images"].if = "github.event_name == 'pull_request'"; },
    (w) => { w.on.pull_request_target = {}; },
    (w) => { w.jobs.quality.services.postgres.ports = ["5432:5432"]; },
    (w) => { w.jobs.quality.services.postgres.options = "--health-cmd=pg_isready"; },
    (w) => { w.jobs["pr-production-images"].steps.find((s) => s.run?.includes("docker buildx build")).run =
      'docker buildx build --load --platform linux/amd64 .'; },
  ]) {
    const invalid = structuredClone(ci);
    mutate(invalid);
    assert.throws(() => assertLocalRunnerWorkflow(invalid));
  }
});
test("release cannot build before CI or occupy sole runner waiting for CI", () => {
  const owner = workflows[1].workflow;
  for (const mutate of [
    (w) => { w.jobs.images.needs = ["source"]; },
    (w) => { w.jobs.ci.steps.find((s) => s.run?.includes("wait-ci")).run = "node scripts/owner-release.mjs wait-ci"; },
    (w) => { w.jobs.ci["timeout-minutes"] = 100; },
  ]) {
    const invalid = structuredClone(owner);
    mutate(invalid);
    assert.throws(() => assertLocalRunnerWorkflow(invalid, { owner: true }));
  }
});

test("PR build rejects quoted and unquoted network or entitlement overrides without rejecting runtime network isolation", () => {
  for (const option of ['--network="host"', "--network='host'", '--network "host"', "--network 'host'", '--network=host', '--allow="network.host"']) {
    const invalid = structuredClone(workflows[0].workflow);
    const step = invalid.jobs['pr-production-images'].steps.find((value) => value.run?.includes('docker buildx build'));
    step.run = step.run.replace('docker buildx build', 'docker buildx build ' + option);
    assert.throws(() => assertLocalRunnerWorkflow(invalid), /must not request entitlements or override build networking/u);
  }
  assert.equal(assertLocalRunnerWorkflow(workflows[0].workflow), true);
});

test("require-complete rejects queued or missing push CI without occupying the runner, and writes exact successful evidence", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "workbench-ci-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const gh = path.join(directory, "gh");
  writeFileSync(gh, "#!" + process.execPath + "\nimport fs from 'node:fs';\nconst fixture=JSON.parse(fs.readFileSync(process.env.CI_FIXTURE));\nprocess.stdout.write(JSON.stringify(process.argv[3].includes('/jobs?') ? fixture.jobs : fixture.runs));\n");
  chmodSync(gh, 0o700);
  const filename = path.join(directory, "fixture.json");
  const output = path.join(directory, "evidence.json");
  const commit = "a".repeat(40);
  const run = { id: 10, run_attempt: 1, head_sha: commit, head_branch: "main", head_repository: { full_name: "harrylee-bot/ai-product-workbench" },
    event: "push", path: ".github/workflows/workbench-ci.yml", status: "completed", conclusion: "success" };
  const jobs = REQUIRED_CI_JOBS.map((name, i) => ({ name, id: i + 1, status: "completed", conclusion: "success" }));
  const invoke = () => execFileSync(process.execPath, [new URL("./owner-release.mjs", import.meta.url).pathname, "wait-ci",
    "--repository", "harrylee-bot/ai-product-workbench", "--commit", commit, "--output", output, "--require-complete", "true"],
  { env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, CI_FIXTURE: filename },
    timeout: 5000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  for (const runs of [[], [{ ...run, status: "queued", conclusion: null }]]) {
    writeFileSync(filename, JSON.stringify({ runs: { workflow_runs: runs }, jobs: { jobs } }));
    assert.throws(invoke, (error) => error.status === 1 && error.stderr.includes("must already be successful"));
  }
  writeFileSync(filename, JSON.stringify({ runs: { workflow_runs: [run] }, jobs: { jobs } }));
  assert.match(invoke(), /Exact candidate CI passed: 10 attempt 1/u);
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { run, jobs });
});


import assert from "node:assert/strict";

export const LOCAL_RUNNER_LABELS = Object.freeze(["self-hosted", "Linux", "ARM64", "workbench-local-build"]);
export const TRUSTED_CI_EVENT = "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main' && github.event.pull_request.base.repo.full_name == github.repository && github.event.pull_request.head.repo.full_name == github.repository)";
const MANUAL_CI = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.release == true";
const MANUAL_OWNER = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.approve == true";
const GUARD = "python3 scripts/workbench-local-runner.py ";
const BUILDER = "${{ env.WORKBENCH_JOB_BUILDER }}";
const CI_TECHNICAL_JOBS = new Set(["release-chain", "quality", "real-stack-browser", "deployment-config"]);

function assertBuilder(job, id) {
  const steps = job.steps;
  const index = steps.findIndex((step) => step.uses?.startsWith("docker/setup-buildx-action@"));
  if (index === -1) return;
  const setup = steps[index];
  const settings = setup.with ?? {};
  assert.equal(settings.name, BUILDER, `${id}: builder must belong to this job`);
  assert.equal(settings.driver, "docker-container", `${id}: container build driver required`);
  assert.equal(settings.endpoint, "unix:///var/run/docker.sock", `${id}: local Docker socket required`);
  assert.deepEqual(String(settings["driver-opts"]).trim().split(/\r?\n/u).map((line) => line.trim()).sort(),
    ["memory=4294967296", "memory-swap=4294967296", "cpu-period=100000", "cpu-quota=200000", "network=bridge",
      "env.http_proxy=${{ env.WORKBENCH_BUILD_PROXY }}", "env.https_proxy=${{ env.WORKBENCH_BUILD_PROXY }}",
      "env.no_proxy=${{ env.WORKBENCH_BUILD_NO_PROXY }}"].sort(),
    `${id}: exact 4 GiB/2 CPU build caps required`);
  assert.equal(settings["buildkitd-config"], "deploy/workbench-buildkitd.toml", `${id}: serial BuildKit policy required`);
  assert.equal(settings["buildkitd-flags"], "--oci-worker-net=bridge", `${id}: no insecure entitlements allowed`);
  assert.equal(settings.cleanup, false, `${id}: owned cleanup must control builder removal`);
  assert.equal(steps[index + 1]?.run, GUARD + "verify-builder", `${id}: inspect actual builder before use`);
  const builds = steps.filter((step) => step.uses?.startsWith("docker/build-push-action@"));
  for (const build of builds) {
    assert.equal(build.with.platforms, "linux/amd64", `${id}: production platform must be explicit AMD64`);
    assert.equal(build.with.builder, BUILDER, `${id}: build must use bounded owned builder`);
    assert(!("cache-from" in build.with) && !("cache-to" in build.with), `${id}: remote build caches forbidden`);
    assert(!build.with.allow && !build.with.network, `${id}: build requests must not request insecure entitlements or host networking`);
  }
  if (builds.length) {
    const buildIndex = steps.indexOf(builds.at(-1));
    const releaseIndex = steps.findIndex((step) => step.run === GUARD + "release-builder");
    const smokeIndex = steps.findIndex((step) => step.run?.startsWith(GUARD + "image-smoke "));
    assert(releaseIndex > buildIndex && smokeIndex > releaseIndex, `${id}: free builder memory before actual image smoke`);
    assert(steps[smokeIndex].run.includes('--commit "$GITHUB_SHA"') && steps[smokeIndex].run.includes('--image "$IMAGE_REF"'),
      `${id}: smoke must bind the exact image and commit`);
  } else {
    const run = steps.find((step) => step.run?.includes("docker buildx build"))?.run ?? "";
    assert(run.includes('--builder "$WORKBENCH_JOB_BUILDER" --platform linux/amd64'), `${id}: PR build must also be bounded AMD64`);
    assert(run.includes('tag="$WORKBENCH_JOB_IMAGE"') && run.includes('--label "io.workbench.job=$WORKBENCH_JOB_BUILDER"'),
      `${id}: loaded image must be owned for exact cleanup`);
    assert(run.includes(GUARD + "release-builder"), `${id}: PR runtime probes must release build memory`);
    const buildCommands = run.replace(/\\\r?\n[ \t]*/gu, " ").split("\n").filter((line) => /\bdocker\s+buildx\s+build\b/u.test(line));
    assert(buildCommands.length === 1 && !/--(?:allow|network)(?:[=\s]|["'])/u.test(buildCommands[0]),
      `${id}: PR builds must not request entitlements or override build networking`);
  }
}

/** Keep compute outside production and protect a persistent ARM64 runner. */
export function assertLocalRunnerWorkflow(workflow, { owner = false } = {}) {
  assert(workflow.jobs && Object.keys(workflow.jobs).length > 0, "local runner workflow requires jobs");
  assert.equal(workflow.env?.DOCKER_BUILD_RECORD_UPLOAD, "false", "disable hidden Docker artifact upload");
  assert.equal(workflow.env?.DOCKER_BUILD_SUMMARY, "false", "disable hidden Docker build summaries");
  assert(!Object.hasOwn(workflow.on ?? {}, "pull_request_target"), "privileged fork events are forbidden");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.deepEqual(job["runs-on"], [...LOCAL_RUNNER_LABELS], `${id}: only the dedicated local ARM64 runner is allowed`);
    assert(!job.container, `${id}: job container would bypass host identity probes`);
    assert(!job.env?.DOCKER_HOST && !job.env?.DOCKER_CONTEXT, `${id}: remote Docker override forbidden`);
    if (owner) {
      if (id === "ci") assert.deepEqual(job.needs, ["source"], "owner CI must depend on trusted source");
      else assert.equal(job.if, MANUAL_OWNER, `${id}: explicit main owner dispatch required`);
    } else if (CI_TECHNICAL_JOBS.has(id)) {
      assert.equal(job.if, TRUSTED_CI_EVENT, `${id}: reject untrusted PR before job startup`);
    } else if (id === "pr-production-images") {
      assert.equal(job.if, "(github.event_name == 'pull_request' && needs.quality.outputs.pr_production_image_count != '0') && (" + TRUSTED_CI_EVENT + ")",
        "PR image job must reject foreign forks");
    } else {
      assert.equal(job.if, MANUAL_CI, `${id}: privileged CI dispatch guard required`);
    }
    if (job.strategy?.matrix) assert.equal(job.strategy["max-parallel"], 1, `${id}: serial matrix required`);
    assert(job.steps?.[0]?.uses?.startsWith("actions/checkout@"), `${id}: fresh checkout required`);
    assert.equal(job.steps[1]?.run, GUARD + "prepare", `${id}: guard must precede dependencies and builds`);
    assert.equal(job.steps.at(-1)?.run, GUARD + "cleanup", `${id}: scoped cleanup required`);
    assert.equal(job.steps.at(-1)?.if, "always()", `${id}: failures also require cleanup`);
    if (id === "real-stack-browser") {
      const smoke = job.steps.find((step) => step.run === "npm run e2e:web:real-stack:browser-only");
      const evidence = job.steps.find((step) => step.run === "python3 scripts/workbench-ci-artifacts.py upload");
      assert(smoke && evidence, "browser smoke and durable evidence are required");
      for (const subject of [job, smoke, evidence]) {
        assert(!subject["continue-on-error"], "browser checks and evidence must fail closed");
      }
      assert.equal(evidence.env?.WORKBENCH_ARTIFACT_PATH, "output/playwright/real-stack", "missing browser evidence must fail closed");
      assert.equal(evidence.env?.WORKBENCH_ARTIFACT_NAME, "real-stack-browser-${{ github.sha }}-${{ github.run_attempt }}", "browser evidence must bind the candidate and attempt");
      assert.equal(evidence.if, "always()", "failed browser tests must also publish diagnostics");
    }
    for (const step of job.steps) {
      if (step.run?.startsWith("python3 scripts/workbench-ci-artifacts.py ")) {
        assert(["python3 scripts/workbench-ci-artifacts.py upload", "python3 scripts/workbench-ci-artifacts.py download"].includes(step.run), `${id}: exact local artifact transport required`);
        assert(!step["continue-on-error"], `${id}: local evidence must fail closed`);
        assert(step.env?.WORKBENCH_ARTIFACT_NAME?.includes("${{ github.run_attempt }}"), `${id}: evidence must bind the exact attempt`);
        assert(step.env?.WORKBENCH_ARTIFACT_PATH?.startsWith("output/") || step.env?.WORKBENCH_ARTIFACT_PATH === "output", `${id}: evidence must stay in output`);
        if (step.run.endsWith(" upload")) {
          assert.equal(step.env.WORKBENCH_ARTIFACT_RETENTION_DAYS, owner && id === "release" ? "7" : "1", `${id}: bounded local evidence retention required`);
        }
      }
      if (owner) assert(!/actions\/(?:upload|download)-artifact@/u.test(step.uses ?? ""), `${id}: owner evidence must not depend on cloud artifact quota`);
      assert(!step.uses?.startsWith("actions/cache"), `${id}: Actions cloud cache forbidden`);
      assert(!step.env?.DOCKER_HOST && !step.env?.DOCKER_CONTEXT, `${id}: remote Docker step override forbidden`);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with?.clean, true, `${id}: clean workspace required`);
        assert.equal(step.with?.["persist-credentials"], false, `${id}: never persist checkout credentials`);
      }
      if (step.uses?.startsWith("actions/setup-node@")) assert(!step.with?.cache, `${id}: npm cloud cache forbidden`);
      if (step.uses?.startsWith("actions/upload-artifact@")) {
        assert.equal(step.with?.["retention-days"], owner && id === "release" ? 7 : 1, `${id}: bounded evidence retention required`);
      }
      if (step.uses?.startsWith("anchore/sbom-action@")) {
        assert.equal(step.with?.["upload-artifact"], false, `${id}: hidden SBOM upload forbidden`);
        assert.equal(step.env?.SYFT_PLATFORM, "linux/amd64", `${id}: SBOM must inspect AMD64`);
      }
      if (step.uses?.startsWith("aquasecurity/trivy-action@")) {
        assert.equal(step.with?.cache, false, `${id}: vulnerability cloud cache forbidden`);
        assert.equal(step.env?.TRIVY_PLATFORM, "linux/amd64", `${id}: scan must inspect AMD64`);
        assert.equal(step.env?.TRIVY_IMAGE_SRC, "remote", `${id}: scan must bind registry image`);
      }
      assert(!/docker\s+(?:system|image|container|volume)\s+prune/u.test(step.run ?? ""), `${id}: broad Docker prune forbidden`);
    }
    for (const [name, service] of Object.entries(job.services ?? {})) {
      assert.equal(name, "postgres", `${id}: unexpected persistent-runner service`);
      assert.deepEqual(service.ports, ["127.0.0.1::5432"], `${id}: services must bind isolated loopback ports`);
      for (const cap of ["--memory=1g", "--memory-swap=1g", "--cpus=1", "--pids-limit=128"]) {
        assert(service.options?.includes(cap), `${id}: test service resource limits required`);
      }
      const portStep = job.steps.find((step) => step.env?.TEST_POSTGRES_PORT);
      assert.equal(portStep?.env?.TEST_POSTGRES_PORT, "${{ job.services.postgres.ports[5432] }}", `${id}: use runner-assigned test port`);
      assert(portStep?.run?.includes('>> "$GITHUB_ENV"'), `${id}: database URLs must use assigned service port`);
    }
    assertBuilder(job, id);
  }
  if (owner) {
    assert.deepEqual(workflow.jobs.images.needs, ["source", "ci"], "images must wait for complete exact-source CI");
    assert(workflow.jobs.ci.steps.some((step) => step.run?.includes("owner-release.mjs wait-ci") && step.run.includes("--require-complete true")),
      "single runner release must fail immediately when push CI is incomplete");
    assert(workflow.jobs.ci["timeout-minutes"] <= 15, "release must not occupy the sole runner waiting for CI");
  }
  return true;
}


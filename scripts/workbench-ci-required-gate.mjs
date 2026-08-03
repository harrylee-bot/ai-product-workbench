import path from "node:path";
import { pathToFileURL } from "node:url";

const JOB_RESULTS = new Set(["success", "failure", "cancelled", "skipped"]);
const COMMON_REQUIRED_JOBS = Object.freeze([
  "candidate-source-policy",
  "release-chain",
  "typecheck-linux-16g",
  "quality",
  "real-stack-browser",
  "deployment-config",
]);
const PRODUCTION_REQUIRED_JOBS = Object.freeze([
  "release-chain-signing",
  "production-images",
  "image-evidence",
  "deployment-config-evidence",
]);
const PR_JOBS = Object.freeze([
  "pr-production-image-selection",
  "pr-production-images",
  "pr-production-images-fork-policy",
]);

export function evaluateWorkbenchCiGate({
  eventName,
  ref,
  internalPullRequest,
  changedImageCount,
  jobs,
}) {
  const findings = [];
  const addFinding = (status, code, message) => findings.push({ status, code, message });
  const resultFor = (jobId) => {
    const result = jobs?.[jobId];
    if (JOB_RESULTS.has(result)) return result;
    addFinding("FAIL", "JOB_RESULT_INVALID", `${jobId} has no valid terminal result`);
    return null;
  };
  const expectResult = (jobId, expected) => {
    const actual = resultFor(jobId);
    if (actual === expected) return;
    const status = expected === "success" && (actual === null || actual === "skipped")
      ? "BLOCKED"
      : "FAIL";
    const suffix = jobId === "typecheck-linux-16g" && actual === "skipped"
      ? "; configure WORKBENCH_TYPECHECK_RUNNER for a Linux runner with at least 15360 MiB"
      : "";
    addFinding(status, "JOB_RESULT_MISMATCH", `${jobId} must be ${expected}, got ${actual ?? "missing"}${suffix}`);
  };

  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    addFinding("FAIL", "JOBS_INVALID", "job results must be an object");
  }
  for (const jobId of COMMON_REQUIRED_JOBS) expectResult(jobId, "success");

  if (eventName === "pull_request") {
    for (const jobId of PRODUCTION_REQUIRED_JOBS) expectResult(jobId, "skipped");
    if (internalPullRequest === true) {
      expectResult("pr-production-image-selection", "success");
      expectResult("pr-production-images-fork-policy", "skipped");
      const count = parseChangedImageCount(changedImageCount);
      if (count === null) {
        addFinding("FAIL", "PR_IMAGE_COUNT_INVALID", "internal PR changed-image count must be a non-negative integer");
      } else {
        expectResult("pr-production-images", count === 0 ? "skipped" : "success");
      }
    } else if (internalPullRequest === false) {
      expectResult("pr-production-image-selection", "skipped");
      expectResult("pr-production-images", "skipped");
      const policyResult = resultFor("pr-production-images-fork-policy");
      if (policyResult === "success") {
        addFinding("FAIL", "FORK_POLICY_BYPASSED", "fork PR production-image policy must not report success without a trusted rerun");
      } else {
        addFinding(
          "BLOCKED",
          "FORK_PR_REQUIRES_TRUSTED_RERUN",
          "fork PR production images require this exact commit to be rerun from a trusted repository branch",
        );
      }
    } else {
      addFinding("FAIL", "PR_ORIGIN_INVALID", "pull_request must declare whether the head repository is trusted");
      for (const jobId of PR_JOBS) resultFor(jobId);
    }
  } else if (eventName === "push") {
    for (const jobId of PR_JOBS) expectResult(jobId, "skipped");
    if (ref === "refs/heads/production") {
      for (const jobId of PRODUCTION_REQUIRED_JOBS) expectResult(jobId, "success");
    } else if (ref === "refs/heads/main") {
      for (const jobId of PRODUCTION_REQUIRED_JOBS) expectResult(jobId, "skipped");
    } else {
      addFinding("FAIL", "PUSH_REF_INVALID", `unsupported push ref ${String(ref)}`);
      for (const jobId of PRODUCTION_REQUIRED_JOBS) resultFor(jobId);
    }
  } else {
    addFinding("FAIL", "EVENT_INVALID", `unsupported workflow event ${String(eventName)}`);
    for (const jobId of [...PR_JOBS, ...PRODUCTION_REQUIRED_JOBS]) resultFor(jobId);
  }

  const status = findings.some((finding) => finding.status === "FAIL")
    ? "FAIL"
    : findings.some((finding) => finding.status === "BLOCKED")
      ? "BLOCKED"
      : "PASS";
  return { status, findings };
}

export function parseWorkbenchCiGateEnvironment(environment) {
  let needs;
  try {
    needs = JSON.parse(environment.WORKBENCH_CI_JOB_RESULTS_JSON ?? "");
  } catch {
    throw new Error("WORKBENCH_CI_JOB_RESULTS_JSON must be valid JSON");
  }
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    throw new Error("WORKBENCH_CI_JOB_RESULTS_JSON must contain a needs object");
  }
  const internalPullRequest = parseBoolean(environment.WORKBENCH_CI_PR_IS_INTERNAL);
  const jobs = Object.fromEntries(Object.entries(needs).map(([jobId, value]) => [jobId, value?.result]));
  return {
    eventName: environment.WORKBENCH_CI_EVENT_NAME,
    ref: environment.WORKBENCH_CI_REF,
    internalPullRequest,
    changedImageCount: environment.WORKBENCH_CI_PR_CHANGED_IMAGE_COUNT,
    jobs,
  };
}

function parseChangedImageCount(value) {
  const normalized = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

async function main() {
  const result = evaluateWorkbenchCiGate(parseWorkbenchCiGateEnvironment(process.env));
  process.stdout.write(`WORKBENCH_CI_GATE ${JSON.stringify(result)}\n`);
  if (result.status !== "PASS") {
    for (const finding of result.findings) {
      process.stderr.write(`[${finding.status}] ${finding.code}: ${finding.message}\n`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}

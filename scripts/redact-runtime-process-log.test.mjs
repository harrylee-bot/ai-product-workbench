import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

const execFileAsync = promisify(execFile);
const script = new URL("./redact-runtime-process-log.mjs", import.meta.url);
const workflow = new URL("../.github/workflows/workbench-ci.yml", import.meta.url);

test("runtime process command receipt never copies raw output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-runtime-log-"));
  const rawPath = path.join(directory, "raw.log");
  const outputPath = path.join(directory, "status.json");
  const secret = "run-with-sensitive-response-body";
  await writeFile(rawPath, `[e2e] ${secret}\nhttps://internal.example.test/run/${secret}\n`);
  await execFileAsync(process.execPath, [
    script.pathname,
    "--raw", rawPath,
    "--output", outputPath,
    "--exit-code", "17",
    "--candidate", "a".repeat(40),
  ]);
  const receipt = JSON.parse(await readFile(outputPath, "utf8"));
  await assert.rejects(
    access(rawPath),
    (error) => error?.code === "ENOENT",
  );
  assert.deepEqual(receipt, {
    schema: "workbench.runtime-process-command-status.v1",
    command: "runtime:process-convergence:postgres",
    candidateSourceCommit: "a".repeat(40),
    exitCode: 17,
    result: "FAIL",
    rawOutputCaptured: false,
    rawOutputDiscarded: true,
    rawOutputSha256: receipt.rawOutputSha256,
  });
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret, "u"));
  assert.match(receipt.rawOutputSha256, /^[a-f0-9]{64}$/u);
});

test("CI deletes raw Runtime process output and publishes only the redacted receipt", async () => {
  const source = await readFile(workflow, "utf8");
  const parsed = YAML.parse(source);
  const qualitySteps = parsed.jobs?.quality?.steps ?? [];
  const convergence = qualitySteps.find((step) => step.id === "runtime_process_convergence");
  const upload = qualitySteps.find(
    (step) => step.name === "Upload process-level Runtime convergence evidence",
  );

  assert.ok(convergence, "Runtime process convergence step is required");
  assert.match(convergence.run, /trap cleanup_runtime_process_log EXIT/u);
  assert.match(convergence.run, /node scripts\/redact-runtime-process-log\.mjs/u);
  assert.match(convergence.run, /--candidate "\$WORKBENCH_CANDIDATE_SHA"/u);
  assert.doesNotMatch(convergence.run, /cat "\$log_file"/u);
  assert.match(convergence.run, /cat "\$evidence_dir\/command-status\.json"/u);
  assert.match(upload?.with?.path ?? "", /command-status\.json/u);
  assert.doesNotMatch(upload?.with?.path ?? "", /\.log(?:\n|$)/u);
});

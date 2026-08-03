#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";

const args = parseArgs(process.argv.slice(2));
const raw = await readFile(args.raw, "utf8");
const exitCode = Number(args.exitCode);
if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
  throw new Error("RUNTIME_PROCESS_LOG_INVALID_EXIT_CODE");
}
if (!/^[a-f0-9]{40}$/u.test(args.candidate)) {
  throw new Error("RUNTIME_PROCESS_LOG_INVALID_CANDIDATE");
}
const rawOutputSha256 = createHash("sha256").update(raw).digest("hex");
await unlink(args.raw);

const receipt = {
  schema: "workbench.runtime-process-command-status.v1",
  command: "runtime:process-convergence:postgres",
  candidateSourceCommit: args.candidate,
  exitCode,
  result: exitCode === 0 ? "PASS" : "FAIL",
  rawOutputCaptured: false,
  rawOutputDiscarded: true,
  rawOutputSha256,
};
await writeFile(args.output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("RUNTIME_PROCESS_LOG_INVALID_ARGUMENTS");
    values[key.slice(2)] = value;
    index += 1;
  }
  for (const key of ["raw", "output", "exit-code", "candidate"]) {
    if (!values[key]) throw new Error(`RUNTIME_PROCESS_LOG_MISSING_${key.toUpperCase().replaceAll("-", "_")}`);
  }
  return {
    raw: values.raw,
    output: values.output,
    exitCode: values["exit-code"],
    candidate: values.candidate,
  };
}

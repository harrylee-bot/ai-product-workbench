import test from "node:test";
import { execFileSync } from "node:child_process";

test("deployment orchestration contract passes", () => {
  execFileSync(process.execPath, ["scripts/assert-workbench-deployment-orchestration.mjs"], { stdio: "pipe" });
});

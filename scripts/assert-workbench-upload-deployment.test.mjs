import { execFileSync } from "node:child_process";
import test from "node:test";

test("browser upload deployment contract passes", () => {
  execFileSync(process.execPath, ["scripts/assert-workbench-upload-deployment.mjs"], { stdio: "pipe" });
});

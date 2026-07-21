import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const staleRouteTypes = path.join(repoRoot, "apps", "web", ".next", "types", "routes.d.ts");

test("clean Web type generation replaces stale route declarations without source drift", async () => {
  const before = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot })).stdout;
  await mkdir(path.dirname(staleRouteTypes), { recursive: true });
  await writeFile(staleRouteTypes, "declare const staleRouteTypesMustNotBeUsed: never;\n");
  try {
    await execFileAsync(process.execPath, ["scripts/workbench-web-typegen.mjs"], {
      cwd: repoRoot,
      env: { ...process.env, WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL: "http://127.0.0.1:9000/workbench" },
    });
    await access(path.join(repoRoot, "apps", "web", ".next", "types", "routes.d.ts"));
    const after = (await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot })).stdout;
    assert.equal(after, before);
  } finally {
    await rm(path.join(repoRoot, "apps", "web", ".next"), { recursive: true, force: true });
  }
});

test("Web typecheck invokes the clean type generation contract", async () => {
  const packageJson = await import("node:fs/promises").then(({ readFile }) => readFile(
    path.join(repoRoot, "apps", "web", "package.json"),
    "utf8",
  ));
  const packageData = JSON.parse(packageJson);
  assert.match(packageData.scripts.typecheck, /npm run typegen/u);
  assert.equal(packageData.scripts.typegen, "node ../../scripts/workbench-web-typegen.mjs");
});

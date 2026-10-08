import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { access, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const webRoot = path.join(repoRoot, "apps", "web");

export async function runWebTypegen({
  root = repoRoot,
  web = webRoot,
  environment = process.env,
  run = execFileAsync,
} = {}) {
  const before = await gitStatus(root, run);
  const distDir = resolveDistDir(web, environment.WORKBENCH_NEXT_DIST_DIR);
  const temporaryTsconfigPath = path.join(web, ".tsconfig.workbench-typegen.json");
  const nextEnvPath = path.join(web, "next-env.d.ts");
  const originalNextEnv = await readFile(nextEnvPath);

  // Route declarations are derived output. Removing the complete Next output
  // directory prevents a stale route file from influencing tsc.
  await rm(distDir, { recursive: true, force: true });
  await copyFile(path.join(web, "tsconfig.json"), temporaryTsconfigPath);

  const nextBin = createRequire(path.join(web, "package.json")).resolve("next/dist/bin/next");
  const childEnvironment = {
    ...environment,
    // next.config.ts validates this value while loading. Type generation is
    // non-production, so a loopback placeholder is sufficient and contains no secret.
    WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL:
      environment.WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL ?? "http://127.0.0.1:9000/workbench",
    // Next resolves this setting from its project cwd, so keep the temporary
    // config path relative to the Web workspace.
    WORKBENCH_NEXT_TSCONFIG_PATH: path.basename(temporaryTsconfigPath),
  };
  try {
    await run(process.execPath, [nextBin, "typegen"], {
      cwd: web,
      env: childEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    await rm(temporaryTsconfigPath, { force: true });
    await writeFile(nextEnvPath, originalNextEnv);
  }

  const routeTypes = path.join(distDir, "types", "routes.d.ts");
  await access(routeTypes);
  await assertIgnored(root, routeTypes, run);

  const after = await gitStatus(root, run);
  if (before !== after) {
    throw new Error("Web route type generation changed the repository status");
  }
  return { distDir, routeTypes, status: after };
}

function resolveDistDir(web, configured) {
  const candidate = path.resolve(web, configured?.trim() || ".next");
  const relative = path.relative(web, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("WORKBENCH_NEXT_DIST_DIR must stay inside apps/web");
  }
  return candidate;
}

async function gitStatus(root, run) {
  const result = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
  return result.stdout;
}

async function assertIgnored(root, file, run) {
  try {
    await run("git", ["check-ignore", "--no-index", "--quiet", path.relative(root, file)], { cwd: root });
  } catch {
    throw new Error(`Generated route types must be ignored by git: ${path.relative(root, file)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebTypegen()
    .then(({ routeTypes }) => console.log(`Generated ${path.relative(repoRoot, routeTypes)}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

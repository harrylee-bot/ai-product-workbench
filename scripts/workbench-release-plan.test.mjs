import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { copyInputs, images, planRelease, releaseEnv } from "../deploy/workbench-release-plan.mjs";

const inputs = Object.fromEntries(Object.entries(images).map(([name, [file]]) => [name, [file, ...copyInputs(readFileSync(file, "utf8"))]]));
const baseline = { "apps/web/app/page.tsx": "a", "apps/workbench-api/src/main.ts": "a", "docs/audit/1.0.0.md": "a" };
function plan(changes) { return planRelease({ snapshot: { ...baseline, ...changes }, previous: { version: 1, snapshot: baseline }, inputs }); }

test("a Web edit builds Web alone; no knowledge or migration image", () => {
  const result = plan({ "apps/web/app/page.tsx": "b" });
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.services, ["workbench-web"]);
});
test("an API edit builds API alone", () => {
  assert.deepEqual(plan({ "apps/workbench-api/src/main.ts": "b" }).services, ["workbench-api"]);
});
test("shared package changes propagate to every Docker consumer", () => {
  const result = plan({ "packages/workbench-export-core/src/index.ts": "b" });
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.services, ["workbench-api", "workbench-export-worker", "workbench-preview", "workbench-temporal-worker", "workbench-worker"]);
});
test("the Temporal executor image tracks its own Dockerfile and build-worker inputs", () => {
  const result = plan({ "apps/workbench-build-worker/src/main.ts": "b" });
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.services, ["workbench-temporal-worker", "workbench-worker"]);
  const ownImage = plan({ "apps/workbench-worker/Dockerfile.temporal": "b" });
  assert(ownImage.services.includes("workbench-temporal-worker"));
  const env = releaseEnv("WORKBENCH_TEMPORAL_WORKER_IMAGE_REF=temporal:old\n", result, "/source", "new", "direct-new");
  assert.match(env, /WORKBENCH_TEMPORAL_WORKER_IMAGE_REF=workbench-temporal-worker:direct-new/);
});
test("knowledge changes build only knowledge", () => {
  assert.deepEqual(plan({ "knowledge-vault/README.md": "b" }).services, ["knowledge"]);
});
test("deletions and renames invalidate the old consumer too", () => {
  const result = planRelease({ snapshot: { "apps/workbench-preview/src/page.ts": "a" }, previous: { version: 1, snapshot: baseline }, inputs });
  assert.deepEqual(result.services, ["workbench-api", "workbench-preview", "workbench-web"]);
});
for (const path of ["package.json", "package-lock.json", "deploy/workbench-compose.yml", "packages/workbench-db/prisma/migrations/new/migration.sql", "packages/workbench-contracts/src/queue.ts", "scripts/reconcile-workbench-runtime-queues.mjs", "new-runtime/config.json"]) {
  test(`${path} requires a full guarded rollout`, () => assert.equal(plan({ [path]: "b" }).mode, "all"));
}
test("first release, missing baseline and explicit full rebuild are conservative", () => {
  assert.equal(planRelease({ snapshot: baseline, inputs }).mode, "all");
  assert.equal(planRelease({ snapshot: baseline, inputs, previous: { version: 1, snapshot: baseline }, force: true }).mode, "all");
});
test("unchanged source and audit-only updates do not build", () => {
  assert.equal(plan({}).mode, "none");
  assert.equal(plan({ "docs/audit/1.0.0.md": "b" }).mode, "none");
});
test("partial release retains other images and the worker's actual source attestation", () => {
  const base = "WORKBENCH_SOURCE_COMMIT=old\nWORKBENCH_API_IMAGE_REF=api:old\nWORKBENCH_WEB_IMAGE_REF=web:old\nWORKBENCH_RUNTIME_WORKER_IMAGE_REF=worker@sha256:old\n";
  const env = releaseEnv(base, plan({ "apps/web/app/page.tsx": "b" }), "/new/source", "new", "direct-new");
  assert.match(env, /WORKBENCH_WEB_IMAGE_REF=workbench-web:direct-new/);
  assert.match(env, /WORKBENCH_API_IMAGE_REF=api:old/);
  assert.match(env, /WORKBENCH_RUNTIME_WORKER_IMAGE_REF=worker@sha256:old/);
  assert.match(env, /WORKBENCH_RUNTIME_WORKER_SOURCE_COMMIT=old/);
  assert.match(env, /WORKBENCH_SOURCE_COMMIT=new/);
});
test("unsupported Docker syntax fails instead of omitting dependencies", () => {
  assert.throws(() => copyInputs('COPY ["apps/web", "/app"]'));
  assert.throws(() => copyInputs("COPY apps/* /app"));
  assert.deepEqual(copyInputs("COPY --from=build /app/dist /app\nCOPY --chown=node:node apps/web packages/shared /app"), ["apps/web", "packages/shared"]);
});

// Execute the actual remote orchestration, replacing only external commands.
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
const remote = readFileSync("deploy/workbench-direct-release.sh", "utf8").match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE/)[1];

test("healthy baseline enables an actual Web-only release; failure cannot promote it", t => {
  const sandbox = mkdtempSync(join(tmpdir(), "workbench-incremental-release-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "release");
  const source = join(root, "source");
  const privateDir = join(sandbox, "private");
  const bin = join(sandbox, "bin");
  const log = join(sandbox, "calls");
  for (const dir of [source, join(root, "incoming"), join(source, "deploy"), join(privateDir, "current"), bin]) mkdirSync(dir, { recursive: true });
  cpSync("deploy/workbench-release-plan.mjs", join(source, "deploy/workbench-release-plan.mjs"));
  writeFileSync(join(source, "deploy/workbench-disk-preflight.mjs"), "");
  const executable = (path, content) => { writeFileSync(path, content); chmodSync(path, 0o755); };
  // Compose run can read stdin; it must not swallow the remaining SSH script.
  executable(join(source, "deploy/server-deploy.sh"), '#!/bin/sh\ncat >/dev/null\nprintf "deploy:%s:%s\\n" "$DEPLOY_TARGET" "$WORKBENCH_DEPLOY_SERVICES" >> "$TEST_LOG"\nexit "${TEST_DEPLOY_FAILURE:-0}"\n');
  for (const [file] of Object.values(images)) {
    mkdirSync(join(source, file, ".."), { recursive: true });
    writeFileSync(join(source, file), `FROM node\nCOPY ${file.split("/").slice(0, 2).join("/")} /app\n`);
  }
  writeFileSync(join(source, "apps/web/page.tsx"), "first");
  const baseEnv = join(privateDir, "current/workbench.env");
  const manifest = join(privateDir, "current/release-plan.json");
  writeFileSync(baseEnv, "WORKBENCH_SOURCE_COMMIT=old\nWORKBENCH_RUNTIME_WORKER_IMAGE_REF=worker:old\n");
  for (const name of ["docker", "flock", "tar"]) executable(join(bin, name), "#!/bin/sh\nexit 0\n");
  executable(join(bin, "npm"), '#!/bin/sh\necho "npm:$*" >> "$TEST_LOG"\n');
  executable(join(bin, "curl"), '#!/bin/sh\n[ "${TEST_HEALTH_FAILURE:-0}" = 0 ] || exit 22\ncase " $* " in *" -w "*) printf 307;; esac\n');
  const run = (overrides = {}) => spawnSync("bash", ["-s", "--", root, privateDir, "b".repeat(40), "direct-b", "https://example.test", "0"], {
    input: remote, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, ...overrides },
  });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(log, "utf8"), /deploy:all:/);
  assert(existsSync(manifest));
  writeFileSync(log, "");
  writeFileSync(join(source, "apps/web/page.tsx"), "second");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), "deploy:selected:workbench-web\n");
  const healthyManifest = readFileSync(manifest, "utf8");
  const healthyEnv = readFileSync(baseEnv, "utf8");
  writeFileSync(join(source, "apps/web/page.tsx"), "third");
  result = run({ TEST_HEALTH_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(manifest, "utf8"), healthyManifest);
  assert.equal(readFileSync(baseEnv, "utf8"), healthyEnv);
  assert(existsSync(join(privateDir, "current/pending-release")));
  writeFileSync(log, "");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(log, "utf8"), /deploy:all:/);
  assert(!existsSync(join(privateDir, "current/pending-release")));
  writeFileSync(log, "");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(log, "utf8"), "");
  writeFileSync(baseEnv, readFileSync(baseEnv, "utf8") + "\nWORKBENCH_NODE_IMAGE=changed\n");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(log, "utf8"), /deploy:all:/);
});


test("documentation copied into an image remains a deployment input", () => {
  const result = planRelease({
    snapshot: { ...baseline, "docs/runtime.md": "new" },
    previous: { version: 1, snapshot: baseline },
    inputs: { ...inputs, "workbench-web": [...inputs["workbench-web"], "docs/runtime.md"] },
  });
  assert.equal(result.mode, "selected");
  assert.deepEqual(result.services, ["workbench-web"]);
});

test("actual release and server scripts gate Temporal promotion on executor health", t => {
  const sandbox = mkdtempSync(join(tmpdir(), "workbench-temporal-release-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, "release");
  const source = join(root, "source");
  const privateDir = join(sandbox, "private");
  const bin = join(sandbox, "bin");
  const log = join(sandbox, "commands.jsonl");
  for (const dir of [source, join(root, "incoming"), join(source, "deploy"), join(privateDir, "current"), bin]) mkdirSync(dir, { recursive: true });
  for (const name of ["workbench-release-plan.mjs", "server-deploy.sh", "workbench-build-resources.sh", "workbench-buildkitd.toml"]) {
    cpSync(`deploy/${name}`, join(source, "deploy", name));
  }
  // Host disk/config gates have separate integration suites; this fixture supplies
  // accepted inputs while executing the real release, build and rollout scripts.
  writeFileSync(join(source, "deploy/workbench-disk-preflight.mjs"), "");
  const executable = (file, contents) => { writeFileSync(file, contents, { mode: 0o755 }); };
  executable(join(source, "deploy/workbench-production-preflight.sh"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(source, "deploy/workbench-compose.yml"), "services: {}\n");
  for (const [file] of Object.values(images)) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    cpSync(file, join(source, file));
  }
  const executor = join(source, "apps/workbench-build-worker/src/main.ts");
  mkdirSync(dirname(executor), { recursive: true });
  writeFileSync(executor, "first executor");
  const baseEnv = join(privateDir, "current/workbench.env");
  const manifest = join(privateDir, "current/release-plan.json");
  writeFileSync(baseEnv, "WORKBENCH_RUNTIME_WORKER_IMAGE_REF=runtime:old\nWORKBENCH_TEMPORAL_WORKER_IMAGE_REF=temporal:old\n");
  writeFileSync(log, "");
  for (const name of ["tar", "npm"]) executable(join(bin, name), "#!/bin/sh\nexit 0\n");
  executable(join(bin, "uname"), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo fixture-host; fi\n');
  executable(join(bin, "awk"), '#!/bin/sh\ncase "$*" in *"/proc/meminfo"*) echo 16777216;; *) exec /usr/bin/awk "$@";; esac\n');
  executable(join(bin, "flock"), '#!/bin/sh\nif [ "$1" = --nonblock ]; then shift 4; exec "$@"; fi\n');
  executable(join(bin, "curl"), '#!/bin/sh\ncase " $* " in *" -w "*) printf 307;; esac\n');
  executable(join(bin, "docker"), `#!${process.execPath}\n${temporalReleaseDocker()}`);
  const run = (tag, extra = {}) => spawnSync("bash", ["-s", "--", root, privateDir, "b".repeat(40), tag, "https://example.test", "0"], {
    input: remote, encoding: "utf8", timeout: 30000,
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, TEST_LOG: log, TEST_STATE: sandbox, WORKBENCH_DEPLOY_LOCK_FILE: join(sandbox, "deploy.lock"), WORKBENCH_DEPLOY_HEALTH_TIMEOUT_SECONDS: "1", ...extra },
  });
  let result = run("direct-first");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Service ready: workbench-temporal-worker \(healthy\)/);
  const firstCommands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert(firstCommands.some(args => args.includes("stop") && args.includes("workbench-temporal-worker")));
  const healthyManifest = readFileSync(manifest, "utf8");
  const healthyEnv = readFileSync(baseEnv, "utf8");
  writeFileSync(executor, "changed executor");
  writeFileSync(log, "");
  result = run("direct-executor", { TEST_TEMPORAL_HEALTH: "unhealthy" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Service failed before readiness: workbench-temporal-worker/);
  assert.doesNotMatch(result.stdout, /Healthy release baseline promoted|产品工作台部署完成/);
  const failedPlan = JSON.parse(readFileSync(join(root, "release-plan.json"), "utf8"));
  assert.equal(failedPlan.mode, "selected");
  assert.deepEqual(failedPlan.services, ["workbench-temporal-worker", "workbench-worker"]);
  assert.match(readFileSync(join(root, "direct.env"), "utf8"), /WORKBENCH_TEMPORAL_WORKER_IMAGE_REF=workbench-temporal-worker:direct-executor/);
  assert.equal(readFileSync(manifest, "utf8"), healthyManifest);
  assert.equal(readFileSync(baseEnv, "utf8"), healthyEnv);
  assert(existsSync(join(privateDir, "current/pending-release")));
  const failedCommands = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert(failedCommands.some(args => args.includes("build") && args.includes("workbench-temporal-worker")));
  assert(failedCommands.some(args => args.includes("up") && args.includes("--no-deps") && args.includes("workbench-temporal-worker")));
  assert(!failedCommands.some(args => args[0] === "compose" && (args.includes("stop") || args.includes("migrate"))));
  result = run("direct-recovery");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release plan: all/);
  assert.match(result.stdout, /Healthy release baseline promoted/);
  assert(!existsSync(join(privateDir, "current/pending-release")));
});

function temporalReleaseDocker() { return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + "\n");
const is = (...prefix) => prefix.every((value, index) => args[index] === value);
const state = path.join(process.env.TEST_STATE, "stopped");
const name = process.env.WORKBENCH_BUILD_BUILDER || "workbench-direct-bounded";
const memory = Number(process.env.WORKBENCH_BUILD_MEMORY_MIB || 6144) * 1024 * 1024;
const quota = Number(process.env.WORKBENCH_BUILD_CPUS || 2) * 100000;
const policy = '[worker.oci]\nmax-parallelism = 1\n[registry."docker.io"]\nmirrors = ["docker.m.daocloud.io"]\n';
const output = value => console.log(typeof value === "string" ? value : JSON.stringify(value));
if (is("context", "show")) output("default");
else if (is("context", "inspect")) output("unix:///var/run/docker.sock");
else if (is("info")) output({ OSType: "linux", Name: "fixture-host", MemoryLimit: true, SwapLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true });
else if (is("buildx", "ls")) output({ Name: name, Driver: "docker-container", Nodes: [{ Name: name + "0", Endpoint: "unix:///var/run/docker.sock", Flags: [], DriverOpts: { memory: String(memory), "memory-swap": String(memory), "cpu-period": "100000", "cpu-quota": String(quota), "default-load": "true" }, Files: { "buildkitd.toml": Buffer.from(policy).toString("base64") } }] });
else if (is("inspect", "--type", "container")) output([{ State: { Running: true }, HostConfig: { Memory: memory, MemorySwap: memory, CpuPeriod: 100000, CpuQuota: quota }, Config: { Cmd: ["--config", "/etc/buildkit/buildkitd.toml"] } }]);
else if (is("exec")) output(policy);
else if (is("image", "inspect")) output("runtime@sha256:" + "a".repeat(64));
else if (is("inspect", "--format")) output(args.at(-1) === "workbench-temporal-worker-id" ? process.env.TEST_TEMPORAL_HEALTH || "healthy" : "healthy");
else if (is("compose")) {
  if (args.includes("stop")) fs.writeFileSync(state, "stopped");
  else if (args.includes("up") && args.at(-1) !== "postgres") fs.rmSync(state, { force: true });
  else if (args.includes("ps")) {
    const service = args.at(-1);
    if (service === "-q") output("existing-stack");
    else if (service === "postgres" || !fs.existsSync(state)) output(service + "-id");
  }
}
`; }

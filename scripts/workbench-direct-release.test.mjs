import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = fileURLToPath(new URL("../deploy/workbench-direct-release.sh", import.meta.url));

test("direct release is executable and bypasses GitHub and local VM release paths", () => {
  assert.equal(statSync(script).mode & 0o111, 0o111);
  const source = readFileSync(script, "utf8");
  for (const marker of [
    "git -C \"$REPO_ROOT\" archive",
    "StrictHostKeyChecking=yes",
    "npm run workbench:prepare",
    "WORKBENCH_BUILD_BUILDER",
    "DEPLOY_TARGET=all",
    "deploy/server-deploy.sh",
    "WORKBENCH_SSH_BIND_INTERFACE",
    "BindInterface=",
    "/api/healthz",
  ]) assert(source.includes(marker), `direct release is missing ${marker}`);
  assert.doesNotMatch(source, /github|GitHub|GITHUB_/u);
  assert.doesNotMatch(source, /colima|self-hosted|workbench-owner-release/u);
  assert.doesNotMatch(source, /WORKBENCH_PRODUCTION_BOOTSTRAP_APP_DIR/u);
});

test("direct release fails closed before any SSH action when production binding is incomplete", () => {
  assert.throws(
    () => execFileSync("bash", [script], {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }),
    (error) => error.status === 64 && /WORKBENCH_PRODUCTION_HOST is required/u.test(error.stderr),
  );
});

function releaseFixture(t) {
  const sandbox = mkdtempSync(join(tmpdir(), "workbench-direct-release-test-"));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const fakeBin = join(sandbox, "bin");
  const log = join(sandbox, "calls.jsonl");
  const mock = join(sandbox, "mock.mjs");
  const sourceCommit = "a".repeat(40);
  mkdirSync(fakeBin);
  writeFileSync(log, "");
  writeFileSync(mock, `
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [tool, ...args] = process.argv.slice(2);
const knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile="))?.split("=")[1];
appendFileSync(process.env.WORKBENCH_TEST_LOG, JSON.stringify({
  tool, args,
  knownHostsMode: knownHosts ? statSync(knownHosts).mode & 0o777 : null,
}) + "\\n");
if (tool === process.env.WORKBENCH_TEST_FAIL_TOOL) process.exit(255);
if (tool === "git") {
  if (args.includes("rev-parse")) process.stdout.write("${sourceCommit}\\n");
  if (args.includes("archive")) writeFileSync(args.find((arg) => arg.startsWith("--output=")).slice(9), "fixture archive");
}
if (tool === "ssh") {
  const command = args.at(-1);
  if (process.env.WORKBENCH_TEST_REAL_PREFLIGHT === "1" && command.startsWith("set -eu;")) {
    const result = spawnSync("/bin/bash", ["-c", 'uname() { case "$1" in -s) echo Linux;; -m) echo x86_64;; esac; }; ' + command]);
    process.exit(result.status ?? 1);
  }
  readFileSync(0); // consume the remote script without executing it
}
if (tool === "curl" && args.includes("-w")) process.stdout.write("307");
`);
  for (const name of ["git", "ssh", "scp", "curl"]) {
    const path = join(fakeBin, name);
    writeFileSync(path, `#!/bin/sh\nexec "$WORKBENCH_TEST_NODE" "$WORKBENCH_TEST_MOCK" ${name} "$@"\n`, "utf8");
    chmodSync(path, 0o755);
  }
  return {
    sandbox,
    run(overrides = {}) {
      return spawnSync("/bin/bash", [script], { encoding: "utf8", timeout: 10_000, env: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        TMPDIR: sandbox,
        WORKBENCH_TEST_LOG: log,
        WORKBENCH_TEST_NODE: process.execPath,
        WORKBENCH_TEST_MOCK: mock,
        WORKBENCH_PRODUCTION_HOST: "example.test",
        WORKBENCH_PRODUCTION_USER: "root",
        WORKBENCH_PRODUCTION_KNOWN_HOSTS: "example.test ssh-ed25519 AAAA",
        WORKBENCH_WEB_ORIGIN: "https://example.test",
        WORKBENCH_SOURCE_COMMIT: sourceCommit,
        ...overrides,
      } });
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

function assertStrictTransport(call) {
  for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "ConnectTimeout=15"]) {
    const index = call.args.indexOf(option);
    assert(index > 0, `${call.tool} missing ${option}`);
    assert.equal(call.args[index - 1], "-o");
  }
  const hosts = call.args.find((arg) => arg.startsWith("UserKnownHostsFile="));
  assert(hosts);
  assert.notEqual(hosts, "UserKnownHostsFile=/dev/null");
  assert.equal(call.knownHostsMode, 0o600);
  assert.equal(existsSync(hosts.slice("UserKnownHostsFile=".length)), false, "temporary trust file must be cleaned up");
}

for (const value of [undefined, "", "en6"]) {
  test(`SSH and SCP preserve strict identity checks with interface ${JSON.stringify(value)}`, (t) => {
    const fixture = releaseFixture(t);
    const identity = join(fixture.sandbox, "identity-fixture");
    writeFileSync(identity, "not a real key", { mode: 0o600 });
    const result = fixture.run({ WORKBENCH_SSH_BIND_INTERFACE: value, WORKBENCH_SSH_KEY_PATH: identity });
    assert.equal(result.status, 0, result.stderr);
    const calls = fixture.calls().filter((call) => ["ssh", "scp"].includes(call.tool));
    assert.deepEqual(calls.map((call) => call.tool), ["ssh", "ssh", "scp", "ssh"]);
    for (const call of calls) {
      assertStrictTransport(call);
      assert.equal(call.args[call.args.indexOf("-i") + 1], identity);
      assert.deepEqual(call.args.filter((arg) => arg.startsWith("BindInterface=")), value ? [`BindInterface=${value}`] : []);
      if (value) assert.equal(call.args[call.args.indexOf(`BindInterface=${value}`) - 1], "-o");
    }
  });
}

for (const value of ["en 6", "en6\nx", "en6\r", "-oProxyCommand=x", "en6;x", "'en6'", "en6$(id)", "e".repeat(65)]) {
  test(`invalid interface is rejected before transport: ${JSON.stringify(value)}`, (t) => {
    const fixture = releaseFixture(t);
    const result = fixture.run({ WORKBENCH_SSH_BIND_INTERFACE: value });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /WORKBENCH_SSH_BIND_INTERFACE is invalid/u);
    assert.equal(fixture.calls().filter((call) => ["ssh", "scp", "curl"].includes(call.tool)).length, 0);
  });
}

for (const tool of ["ssh", "scp"]) {
  test(`${tool} binding or authentication failure stops without unbound fallback`, (t) => {
    const fixture = releaseFixture(t);
    const result = fixture.run({ WORKBENCH_SSH_BIND_INTERFACE: "en6", WORKBENCH_TEST_FAIL_TOOL: tool });
    assert.equal(result.status, 255, result.stderr);
    const calls = fixture.calls().filter((call) => ["ssh", "scp", "curl"].includes(call.tool));
    assert.deepEqual(calls.map((call) => call.tool), tool === "ssh" ? ["ssh"] : ["ssh", "ssh", "scp"]);
    for (const call of calls) {
      assertStrictTransport(call);
      assert(call.args.includes("BindInterface=en6"));
    }
  });
}

test("a missing remote application directory fails the real preflight before mkdir or upload", (t) => {
  const fixture = releaseFixture(t);
  const privateDir = join(fixture.sandbox, "private");
  mkdirSync(join(privateDir, "current"), { recursive: true });
  writeFileSync(join(privateDir, "current", "workbench.env"), "# fixture\n");
  const result = fixture.run({
    WORKBENCH_TEST_REAL_PREFLIGHT: "1",
    WORKBENCH_PRODUCTION_APP_DIR: join(fixture.sandbox, "missing-app"),
    WORKBENCH_PRODUCTION_PRIVATE_DIR: privateDir,
  });
  assert.equal(result.status, 1, result.stderr);
  const calls = fixture.calls().filter((call) => ["ssh", "scp", "curl"].includes(call.tool));
  assert.deepEqual(calls.map((call) => call.tool), ["ssh"]);
});

test("missing trust material or identity fails before transport", (t) => {
  for (const overrides of [
    { WORKBENCH_PRODUCTION_KNOWN_HOSTS: "" },
    { WORKBENCH_PRODUCTION_KNOWN_HOSTS: "", WORKBENCH_PRODUCTION_KNOWN_HOSTS_FILE: "/missing/known_hosts" },
    { WORKBENCH_SSH_KEY_PATH: "/missing/identity" },
  ]) {
    const fixture = releaseFixture(t);
    assert.equal(fixture.run(overrides).status, 64);
    assert.equal(fixture.calls().filter((call) => ["ssh", "scp", "curl"].includes(call.tool)).length, 0);
  }
});

import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../deploy/workbench-clamav-notify.sh", import.meta.url));
const fakeClamdscan = `#!/bin/sh
printf '%s\\n' "$*" >> "$QA_COMMAND_LOG"
case " $* " in
  *" --ping="*)
    if [ -n "\${QA_PING_GATE:-}" ]; then
      while [ ! -f "$QA_PING_GATE" ]; do /bin/sleep 0.01; done
    fi
    exit "\${QA_PING_EXIT:-0}" ;;
  *" --version "*)
    if [ -f "$QA_STATE/reloaded" ]; then
      count=0
      [ ! -f "$QA_STATE/reads" ] || count=$(cat "$QA_STATE/reads")
      count=$((count + 1))
      printf '%s\\n' "$count" > "$QA_STATE/reads"
      if [ "$count" -ge "\${QA_VERIFY_AFTER:-1}" ]; then
        printf '%s\\n' "\${QA_VERIFIED_VERSION:-$QA_DISK_VERSION}"
      else
        printf '%s\\n' "$QA_LOADED_VERSION"
      fi
    else
      printf '%s\\n' "$QA_LOADED_VERSION"
    fi ;;
  *" --reload "*) touch "$QA_STATE/reloaded"; exit "\${QA_RELOAD_EXIT:-0}" ;;
  *) exit 9 ;;
esac
`;

async function prepare(directory, overrides = {}) {
  await writeFile(join(directory, "clamdscan"), fakeClamdscan, { mode: 0o755 });
  await writeFile(join(directory, "clamscan"), "#!/bin/sh\nprintf '%s\\n' \"$QA_DISK_VERSION\"\n", { mode: 0o755 });
  await writeFile(join(directory, "timeout"), "#!/bin/sh\nshift\nexec \"$@\"\n", { mode: 0o755 });
  await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    QA_COMMAND_LOG: join(directory, "commands.log"),
    QA_STATE: directory,
    QA_DISK_VERSION: "ClamAV 1.4.5/28124/Tue Sep 15 06:27:28 2026",
    QA_LOADED_VERSION: "ClamAV 1.4.5/28123/Mon Sep 14 06:24:19 2026",
    ...overrides,
  };
}

async function invoke(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "clamav-notify-test-"));
  try {
    const env = await prepare(directory, overrides);
    const result = spawnSync("sh", [script, "--worker"], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    return { ...result, commands: (await readFile(env.QA_COMMAND_LOG, "utf8")).trim().split("\n") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("waits for readiness and confirms the loaded version after requesting one reload", async () => {
  const result = await invoke();
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, [
    "--config-file=/etc/clamav/clamd.conf --ping=150:2",
    "--config-file=/etc/clamav/clamd.conf --version",
    "--config-file=/etc/clamav/clamd.conf --reload",
    "--config-file=/etc/clamav/clamd.conf --version",
  ]);
  assert.match(result.stdout, /Confirmed loaded database: ClamAV 1\.4\.5\/28124/);
});

test("does not reload twice when NotifyClamd already loaded the new database", async () => {
  const result = await invoke({ QA_LOADED_VERSION: "ClamAV 1.4.5/28124/Tue Sep 15 06:27:28 2026" });
  assert.equal(result.status, 0);
  assert.equal(result.commands.length, 2);
  assert(!result.commands.some((command) => command.includes("--reload")));
});

test("reports failed readiness instead of issuing reload commands to an unavailable scanner", async () => {
  const result = await invoke({ QA_PING_EXIT: "1" });
  assert.equal(result.status, 1);
  assert.equal(result.commands.length, 1);
  assert.match(result.stderr, /ERROR: Scanner did not become ready/);
});

test("preserves a failed reload exit status for updater diagnostics", async () => {
  const result = await invoke({ QA_RELOAD_EXIT: "2" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ERROR: Scanner rejected the reload request \(exit 2\)/);
  assert.doesNotMatch(result.stdout, /Confirmed loaded database/);
});

test("waits for a delayed reload instead of treating an acknowledgement as success", async () => {
  const result = await invoke({ QA_VERIFY_AFTER: "3" });
  assert.equal(result.status, 0);
  assert.equal(result.commands.filter((command) => command.includes("--version")).length, 4);
  assert.equal(result.commands.filter((command) => command.includes("--reload")).length, 1);
  assert.match(result.stdout, /Confirmed loaded database/);
});

test("reports a bounded failure when an acknowledged reload never changes the loaded database", async () => {
  const result = await invoke({ QA_VERIFY_AFTER: "99" });
  assert.equal(result.status, 1);
  assert.equal(result.commands.filter((command) => command.includes("--version")).length, 31);
  assert.match(result.stderr, /ERROR: Reload was acknowledged but the expected database was not confirmed/);
  assert.doesNotMatch(result.stdout, /Confirmed loaded database/);
});

test("returns from the first-download hook before clamd starts, then confirms the background reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clamav-notify-bootstrap-test-"));
  const gate = join(directory, "clamd-started");
  const outputPath = join(directory, "output.log");
  let output;
  try {
    const env = await prepare(directory, { QA_PING_GATE: gate });
    output = await open(outputPath, "w");
    const child = spawn("sh", [script], { env, stdio: ["ignore", output.fd, output.fd] });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("The first database update blocked startup waiting for clamd."));
      }, 2_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0);
    const beforeClamdStarts = await readFile(outputPath, "utf8");
    assert.match(beforeClamdStarts, /Queued database reload verification/);
    assert.doesNotMatch(beforeClamdStarts, /Confirmed loaded database/);
    await writeFile(gate, "");
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(outputPath, "utf8")).includes("Confirmed loaded database")) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(completed, "The background worker did not confirm the database after clamd became ready.");
  } finally {
    await writeFile(gate, "").catch(() => {});
    await output?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

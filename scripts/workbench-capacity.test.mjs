import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

test("capacity thresholds, inode failure and bounded transition reporting", () => {
  execFileSync("/usr/bin/python3", ["-S", "-m", "unittest", "scripts/test_workbench_capacity.py"], {
    cwd: new URL("../", import.meta.url), stdio: "pipe",
  });
});

test("all Workbench and DeerFlow containers receive finite log retention on recreation", () => {
  for (const name of ["workbench-compose.yml", "deerflow-runtime-compose.yml"]) {
    const compose = parse(readFileSync(new URL(`../deploy/${name}`, import.meta.url), "utf8"));
    for (const [service, config] of Object.entries(compose.services)) {
      assert.deepEqual(config.logging, {
        driver: "json-file", options: { "max-size": "20m", "max-file": "5" },
      }, `${name}: ${service}`);
    }
  }
});

test("capacity timer is bounded and cannot access Docker or write application data", () => {
  const service = readFileSync(new URL("../deploy/workbench-capacity-check.service", import.meta.url), "utf8");
  const timer = readFileSync(new URL("../deploy/workbench-capacity-check.timer", import.meta.url), "utf8");
  for (const setting of [
    "DynamicUser=yes", "ProtectSystem=strict", "ProtectHome=read-only",
    "StateDirectory=workbench-capacity", "MemoryMax=64M", "TimeoutStartSec=30",
  ]) assert.ok(service.includes(setting), setting);
  assert.ok(timer.includes("OnUnitActiveSec=5min"));
  assert.ok(!service.includes("docker") && !service.includes("sudo"));
});

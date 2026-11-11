import assert from "node:assert/strict";
import test from "node:test";
import { processGroupExitState } from "./workbench-e2e-process.mjs";

test("macOS cleanup waits for observed same-owner ?E/Z members and requires an empty group", () => {
  const state = (snapshot) => processGroupExitState(snapshot, 34, 501);
  assert.equal(state(" 12 0 S\n 34 501 Z\n 34 501 Zs\n"), "exiting");
  assert.equal(state(" 34 501 ?E\n 34 501 Z\n"), "exiting");
  assert.equal(state(" 12 0 S\n"), "gone");
  assert.equal(state(" 645 -2 S\n"), "gone", "unrelated macOS nobody process must not invalidate the snapshot");
  assert.equal(state(" 645 -2 S\n 34 501 ?E\n"), "exiting");
  for (const status of ["S", "R", "T", "U", "I", "Ss", "S+", "D"]) {
    assert.equal(state(` 34 501 Z\n 34 501 ${status}\n`), "live");
  }
  assert.equal(state(" 34 0 ?E\n"), "unowned");
  assert.equal(state(" 34 -2 ?E\n"), "unowned");
  assert.equal(state(" 34 501 ?\n"), "live");
  assert.equal(state("unreadable process snapshot"), "unknown");
  assert.equal(processGroupExitState(" 34 501 Z\n", 0, 501), "unknown");
  assert.equal(state(null), "unknown");
});

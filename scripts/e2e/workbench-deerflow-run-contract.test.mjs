import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { deerFlowNativeRunRequestViolation } from "./workbench-deerflow-run-contract.mjs";

test("controlled runtime rejects the obsolete options that native DeerFlow 2.1 rejects", () => {
  const valid = { stream_resumable: false, stream_mode: ["values", "messages-tuple"] };
  assert.equal(deerFlowNativeRunRequestViolation(valid), null);
  for (const stream_resumable of [true, "false", 0, {}, []]) {
    assert.equal(deerFlowNativeRunRequestViolation({ ...valid, stream_resumable }), "unsupported_run_option");
  }
  for (const stream_mode of ["messages", ["values", "messages"], "unknown", 1, {}, [null]]) {
    assert.equal(deerFlowNativeRunRequestViolation({ ...valid, stream_mode }), "unsupported_stream_mode");
  }
});

test("controlled runtime accepts the exact native optional and supported stream forms", () => {
  for (const stream_resumable of [undefined, null, false]) {
    for (const stream_mode of [undefined, null, [], "values", "messages-tuple", ["updates", "debug", "tasks", "checkpoints", "custom"]]) {
      assert.equal(deerFlowNativeRunRequestViolation({ stream_resumable, stream_mode }), null);
    }
  }
  for (const body of [null, undefined, [], "invalid"]) {
    assert.equal(deerFlowNativeRunRequestViolation(body), "invalid_run_request");
  }
});

test("controlled run POST enforces the native contract before recording or executing a request", async () => {
  const source = await readFile(new URL("../workbench-postgres-http-e2e.mjs", import.meta.url), "utf8");
  const validation = source.indexOf("const requestViolation = deerFlowNativeRunRequestViolation(body);");
  const execution = source.indexOf("const browserFailure = serialized.includes", validation);
  assert.ok(validation > 0 && execution > validation);
  assert.match(source.slice(validation, execution), /response\.writeHead\(422/u);
  assert.match(source.slice(validation, execution), /return;/u);
  assert.match(source, /DEERFLOW_STREAM_MODE: "messages-tuple,values"/u);
});

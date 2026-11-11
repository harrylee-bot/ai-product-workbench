import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { installBrowserSseEvidenceObserver } from "./workbench-browser-sse-evidence.mjs";

function observedFetch(response) {
  const records = [];
  const context = vm.createContext({
    fetch: async () => response,
    URL, TextDecoder, Uint8Array,
    __workbenchRecordSseEvidence: (record) => records.push(record),
  });
  vm.runInContext(`(${installBrowserSseEvidenceObserver.toString()})({ webOrigin: "https://workbench.test" })`, context);
  return { fetch: context.fetch, records };
}

function sseResponse(chunks, options = {}) {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (options.close) controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": options.contentType ?? "text/event-stream" } });
  Object.defineProperty(response, "url", { value: options.url ?? "https://workbench.test/api/v1/runs/test/events?afterSequence=5" });
  response.clone = () => { throw new Error("Evidence must not create a competing clone reader"); };
  return { response, cancelled: () => cancelled };
}

test("records terminal bytes before the application cancels its reader", async () => {
  const fixture = sseResponse(["id: 6\nevent: run.failed\ndata: {\"private\":\"never retain\"}\n\n"]);
  const observed = observedFetch(fixture.response);
  const response = await observed.fetch("unused");
  assert.equal(response, fixture.response);
  assert.equal(response.body.locked, false, "observer must not start reading independently");
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /never retain/u);
  assert.deepEqual(JSON.parse(JSON.stringify(observed.records)), [
    { afterSequence: 5, eventName: "run.failed", sequence: 6 },
  ]);
  await reader.cancel();
  assert.equal(fixture.cancelled(), true);
  reader.releaseLock();
});

test("supports fragmented CRLF frames and only records application-consumed events", async () => {
  const fixture = sseResponse([
    ": heartbeat\r\nid: 6\r\nevent: run.fa",
    "iled\r\ndata: private\r\n\r\nid: 7\nevent: run.cancelled\ndata: private\n\n",
  ], { close: true });
  const observed = observedFetch(fixture.response);
  const reader = (await observed.fetch("unused")).body.getReader();
  assert.equal(observed.records.length, 0);
  await reader.read();
  assert.equal(observed.records.length, 0);
  await reader.read();
  assert.deepEqual(JSON.parse(JSON.stringify(observed.records)), [
    { afterSequence: 5, eventName: "run.failed", sequence: 6 },
    { afterSequence: 5, eventName: "run.cancelled", sequence: 7 },
  ]);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("observation limits never cancel or alter the application stream", async () => {
  const fixture = sseResponse(["data: " + "x".repeat(1_048_577), "\n\n"], { close: true });
  const observed = observedFetch(fixture.response);
  const reader = (await observed.fetch("unused")).body.getReader();
  assert.equal((await reader.read()).value.length, 1_048_583);
  assert.equal((await reader.read()).value.length, 2);
  assert.equal((await reader.read()).done, true);
  assert.equal(fixture.cancelled(), false);
  assert.deepEqual(observed.records, [null]);
});

test("does not observe unrelated responses or swallow application read errors", async () => {
  const unrelated = sseResponse(["data: private\n\n"], { url: "https://other.test/api/v1/runs/test/events", close: true });
  const before = unrelated.response.body.getReader;
  const observed = observedFetch(unrelated.response);
  assert.equal((await observed.fetch("unused")).body.getReader, before);
  assert.deepEqual(observed.records, []);

  const failure = new Error("synthetic read error");
  const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }), {
    headers: { "content-type": "text/event-stream" },
  });
  Object.defineProperty(response, "url", { value: "https://workbench.test/api/v1/runs/test/events" });
  const observedFailure = observedFetch(response);
  const reader = (await observedFailure.fetch("unused")).body.getReader();
  await assert.rejects(reader.read(), (error) => error === failure);
  assert.deepEqual(observedFailure.records, []);
});

import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { PrototypeTemporalWorker } from "../src/prototypes/temporal-worker.js";

const activities = {
  generatePrototype: vi.fn(async () => ({ projectId: "p", planId: "plan", revisionId: "rev", title: "Demo", documentSha256: "a".repeat(64), sourceDocumentSha256: null, pageCount: 1, byteSize: 100 })),
  buildPrototype: vi.fn(async (input) => ({ ...input, htmlSha256: "b".repeat(64), htmlByteSize: 200 })),
  persistPrototypeRevision: vi.fn(async () => undefined),
  persistPrototypeExport: vi.fn(async () => ({ key: "exports/a", sha256: "a".repeat(64), byteSize: 1, mediaType: "text/html" })),
  markPlanFailed: vi.fn(async () => undefined),
  markExportFailed: vi.fn(async () => undefined),
};

describe("prototype workflow boundary", () => {
  it("exposes readiness only after worker start", async () => {
    const worker = new PrototypeTemporalWorker({ healthPort: 0, activities, registerTemporalWorker: vi.fn(async () => undefined) });
    expect(worker.isReady()).toBe(false);
    await worker.start();
    expect(worker.isReady()).toBe(true);
    await worker.stop();
    expect(worker.isReady()).toBe(false);
  });

  it("fails closed when no Temporal SDK registration is available", async () => {
    const worker = new PrototypeTemporalWorker({ healthPort: 0, activities });
    await expect(worker.start()).rejects.toThrow("TEMPORAL_SDK_NOT_CONFIGURED");
    expect(worker.isReady()).toBe(false);
    await worker.stop();
  });

  it("withdraws readiness and rejects commands when the registered SDK worker stops", async () => {
    let running = true;
    const onStart = vi.fn(async () => undefined);
    const worker = new PrototypeTemporalWorker({
      healthPort: 4311,
      activities,
      registerTemporalWorker: async () => undefined,
      isTemporalWorkerRunning: () => running,
      onStart,
    });
    try {
      await worker.start();
      expect((await fetch("http://127.0.0.1:4311/healthz")).status).toBe(200);
      running = false;
      expect(worker.isReady()).toBe(false);
      expect((await fetch("http://127.0.0.1:4311/healthz")).status).toBe(503);
      const response = await fetch("http://127.0.0.1:4311/workflows/start", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: "visualPrototypeGeneration" }),
      });
      expect(response.status).toBe(503);
      expect(onStart).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });

  it("keeps the shared health port not-ready until SDK worker registration resolves", async () => {
    let releaseRegistration!: () => void;
    const registration = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const worker = new PrototypeTemporalWorker({
      healthPort: 4311,
      activities,
      registerTemporalWorker: async () => registration,
    });
    const start = worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = await fetch("http://127.0.0.1:4311/healthz");
    expect(before.status).toBe(503);
    releaseRegistration();
    await start;
    const after = await fetch("http://127.0.0.1:4311/healthz");
    expect(after.status).toBe(200);
    await worker.stop();
  });

  it("routes synchronous lifecycle execution through the ready gateway", async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") { probe.close(); reject(new Error("Unable to allocate test port")); return; }
        const selected = address.port;
        probe.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    const worker = new PrototypeTemporalWorker({
      healthPort: port,
      activities,
      registerTemporalWorker: vi.fn(async () => undefined),
      onExecute: async (payload) => ({ ok: payload.workflow === "visualPrototypeShare", action: payload.action }),
    });
    await worker.start();
    const response = await fetch(`http://127.0.0.1:${port}/workflows/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: "visualPrototypeShare", action: "freeze" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, action: "freeze" });
    await worker.stop();
  });
});

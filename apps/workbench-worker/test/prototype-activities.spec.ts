import { createHash } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFrozenPrototypeHtml } from "@workbench/workbench-build-worker";
import { PrototypeArtifactStorage } from "../src/prototypes/prototype-artifact-storage.js";
vi.mock("@workbench/workbench-build-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workbench/workbench-build-worker")>();
  return { ...actual, buildFrozenPrototypeHtml: vi.fn(actual.buildFrozenPrototypeHtml) };
});
import { createPrototypeActivities } from "../src/prototypes/prototype-activities.js";
import { PrototypeRuntimeBridge } from "../src/prototypes/prototype-runtime-bridge.js";

const config = { deerFlowUrl: "http://deerflow.test/api", deerFlowGatewayUrl: "http://deerflow.test", deerFlowToken: "test-internal-token", artifactBucket: "prototype-tests", artifactPrefix: "prototype-v2", artifactEndpoint: "http://127.0.0.1:9" };
const input = { projectId: "project-1", planId: "plan-1", revisionId: "revision-1", prompt: "Build a dashboard", title: "Dashboard", createdById: "principal-1" };

function persistence() {
  const tx = {
    $queryRaw: vi.fn(),
    prototypePlan: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    prototypeRevision: { findFirst: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const db = { ...tx, $transaction: vi.fn(async (action: (tx: unknown) => Promise<unknown>) => action(tx)) };
  return { tx, db };
}

describe("Prototype generation activity lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates generation and Temporal retry metadata to the durable runtime bridge", async () => {
    const result = { title: "Generated", pages: [{ id: "page_1", slug: "home", title: "Home", route: "/", order: 0, content: "<p>Ready</p>", sha256: createHash("sha256").update("<p>Ready</p>").digest("hex") }] };
    const generate = vi.spyOn(PrototypeRuntimeBridge.prototype, "generate").mockResolvedValue(result);
    const h = persistence();
    h.tx.prototypePlan.findFirst.mockResolvedValue({ status: "generating" });
    h.tx.prototypeRevision.findFirst.mockResolvedValue({ id: input.revisionId, status: "generating", revision: 1, documentSha256: "0".repeat(64) });
    const activities = createPrototypeActivities(h.db as never, config);
    const controller = new AbortController(); const heartbeat = vi.fn(); const retry = { retryCount: 1, retryLimit: 2 };
    const reference = await activities.generatePrototype(input, controller.signal, heartbeat, retry);
    expect(reference).toMatchObject({ revisionId: input.revisionId, pageCount: 1, title: "Generated" });
    expect(reference).not.toHaveProperty("pages");
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ pages: result.pages }) }));
    expect(generate).toHaveBeenCalledWith(input, controller.signal, heartbeat, retry);
  });

  it.each(["storage-failure", "cancel-after-put"])("keeps a draft unready when freezing encounters %s", async outcome => {
    const h = persistence();
    const pages = [{ id: "page_1", slug: "home", title: "Home", route: "/", order: 0, content: "<p>Ready</p>", sha256: createHash("sha256").update("<p>Ready</p>").digest("hex") }];
    const plan = { id: input.planId, status: "generating", revision: 2 };
    const reference = { ...input, documentSha256: createHash("sha256").update(canonicalJson(pages)).digest("hex"), sourceDocumentSha256: null, pageCount: 1, byteSize: Buffer.byteLength(canonicalJson({ pages, sourceDocument: null })) };
    h.tx.prototypePlan.findFirst.mockResolvedValue(plan);
    h.tx.prototypeRevision.findFirst.mockResolvedValue({ id: input.revisionId, title: input.title, pages, sourceDocument: null, status: "generating", revision: 2, documentSha256: reference.documentSha256 });
    vi.mocked(buildFrozenPrototypeHtml).mockResolvedValueOnce({ document: { revisionId: input.revisionId, title: input.title, pages }, html: "<p>Ready</p>", htmlSha256: pages[0]!.sha256, byteSize: 12 });
    vi.spyOn(PrototypeArtifactStorage.prototype, "putImmutable").mockImplementationOnce(async identity => {
      if (outcome === "storage-failure") throw new Error("STORAGE_UNAVAILABLE");
      plan.status = "cancelled";
      return identity;
    });
    const activities = createPrototypeActivities(h.db as never, config);
    await expect(activities.buildPrototype(reference, vi.fn())).rejects.toThrow(outcome === "storage-failure" ? "STORAGE_UNAVAILABLE" : "PROTOTYPE_DRAFT_NOT_ACTIVE");
    expect(h.tx.prototypePlan.updateMany).not.toHaveBeenCalled();
    expect(h.tx.prototypeRevision.updateMany).not.toHaveBeenCalled();
  });

  it("waits for runtime cancellation cleanup before marking a failed plan or revision", async () => {
    let acknowledge!: (status: "cancelled") => void;
    const ack = new Promise<"cancelled">(resolve => { acknowledge = resolve; });
    const cleanup = vi.spyOn(PrototypeRuntimeBridge.prototype, "settlePlanFailure").mockReturnValue(ack);
    const h = persistence(); const activities = createPrototypeActivities(h.db as never, config);
    const operation = activities.markPlanFailed({ planId: input.planId, code: "PROTOTYPE_WORKFLOW_CANCELLED", detail: "Cancelled" });
    expect(cleanup).toHaveBeenCalledWith(input.planId);
    expect(h.db.$transaction).not.toHaveBeenCalled();
    acknowledge("cancelled"); await operation;
    expect(h.tx.prototypePlan.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }));
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "cancelled" }) }));
  });

  it("leaves terminal projections untouched if provider cleanup is still unconfirmed", async () => {
    vi.spyOn(PrototypeRuntimeBridge.prototype, "settlePlanFailure").mockRejectedValue(new Error("PROTOTYPE_RUNTIME_CANCELLATION_PENDING"));
    const h = persistence(); const activities = createPrototypeActivities(h.db as never, config);
    await expect(activities.markPlanFailed({ planId: input.planId, code: "PROTOTYPE_WORKFLOW_CANCELLED", detail: "Cancelled" })).rejects.toThrow("PROTOTYPE_RUNTIME_CANCELLATION_PENDING");
    expect(h.tx.prototypePlan.updateMany).not.toHaveBeenCalled(); expect(h.tx.prototypeRevision.updateMany).not.toHaveBeenCalled();
  });

  it("accepts an exact completed persistence replay without incrementing revisions", async () => {
    const pages: never[] = []; const hash = createHash("sha256").update(canonicalJson(pages)).digest("hex");
    const h = persistence();
    h.tx.prototypePlan.findFirst.mockResolvedValue({ status: "ready", revision: 4 });
    h.tx.prototypeRevision.findFirst.mockResolvedValue({ title: input.title, pages, sourceDocument: null, builtArtifactKey: "artifact", builtArtifactSha256: "a".repeat(64), builtArtifactByteSize: 100, builtArtifactMediaType: "text/html; charset=utf-8", status: "confirmed", revision: 5, documentSha256: hash });
    const activities = createPrototypeActivities(h.db as never, config);
    await activities.persistPrototypeRevision({ ...input, documentSha256: hash, sourceDocumentSha256: null, pageCount: 0, byteSize: Buffer.byteLength(canonicalJson({ pages, sourceDocument: null })), artifactKey: "artifact", htmlSha256: "a".repeat(64), htmlByteSize: 100, htmlMediaType: "text/html; charset=utf-8" });
    expect(h.tx.prototypePlan.updateMany).not.toHaveBeenCalled(); expect(h.tx.prototypeRevision.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a plan after a cancellation wins the compare-and-set", async () => {
    const h = persistence();
    h.tx.prototypePlan.findFirst.mockResolvedValue({ status: "generating", revision: 4 });
    h.tx.prototypeRevision.findFirst.mockResolvedValue({ title: input.title, pages: [], sourceDocument: null, builtArtifactKey: "artifact", builtArtifactSha256: "a".repeat(64), builtArtifactByteSize: 100, builtArtifactMediaType: "text/html; charset=utf-8", status: "generating", revision: 1, documentSha256: createHash("sha256").update(canonicalJson([])).digest("hex") });
    h.tx.prototypePlan.updateMany.mockResolvedValue({ count: 0 });
    const activities = createPrototypeActivities(h.db as never, config);
    await expect(activities.persistPrototypeRevision({ ...input, documentSha256: createHash("sha256").update(canonicalJson([])).digest("hex"), sourceDocumentSha256: null, pageCount: 0, byteSize: Buffer.byteLength(canonicalJson({ pages: [], sourceDocument: null })), artifactKey: "artifact", htmlSha256: "a".repeat(64), htmlByteSize: 100, htmlMediaType: "text/html; charset=utf-8" })).rejects.toThrow("PROTOTYPE_PLAN_NOT_ACTIVE");
    expect(h.tx.prototypeRevision.updateMany).not.toHaveBeenCalled();
  });
});

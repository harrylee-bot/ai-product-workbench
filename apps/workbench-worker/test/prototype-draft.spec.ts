import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pinGeneratedPrototypeDraft, readPrototypeDraft, recordPrototypeBuild, commitPrototypeDraft } from "../src/prototypes/prototype-draft.js";

const input = { projectId: "project-1", planId: "plan-1", revisionId: "revision-1", prompt: "Make", title: "Demo", createdById: "owner-1" };
function page(id: number, size = 100) {
  const content = `<p>${"x".repeat(size)}</p>`;
  return { id: `page-${id}`, slug: `page-${id}`, title: `Page ${id}`, route: `/page-${id}`, order: id, content, sha256: createHash("sha256").update(content).digest("hex") };
}
function harness() {
  const plan = { id: input.planId, projectId: input.projectId, rootPlanId: null, status: "generating", revision: 1 };
  const revision = { id: input.revisionId, title: input.title, pages: [page(0)], sourceDocument: null, documentSha256: "0".repeat(64), status: "generating", revision: 1 };
  const tx = {
    $queryRaw: vi.fn(),
    prototypePlan: { findFirst: vi.fn(async () => plan), updateMany: vi.fn(async () => { if (plan.status !== "generating") return { count: 0 }; plan.status = "ready"; plan.revision++; return { count: 1 }; }) },
    prototypeRevision: { findFirst: vi.fn(async () => revision), updateMany: vi.fn(async ({ data }) => { Object.assign(revision, data, { revision: revision.revision + 1 }); return { count: 1 }; }) },
  };
  return { plan, revision, tx, db: { ...tx, $transaction: vi.fn(async callback => callback(tx)) } as never };
}

describe("Temporal prototype draft references", () => {
  it("keeps a 50-page payload out of every generation/build/persist history argument", async () => {
    const h = harness();
    const pages = Array.from({ length: 50 }, (_, i) => page(i, 60_000));
    expect(Buffer.byteLength(JSON.stringify(pages))).toBeGreaterThan(2_000_000);
    const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages });
    expect(reference.pageCount).toBe(50);
    expect(reference.byteSize).toBeGreaterThan(3_000_000);
    expect(JSON.stringify(reference).length).toBeLessThan(600);
    const built = await recordPrototypeBuild(h.db, reference, { key: "prototype-v2/project/revision/preview.html", sha256: "b".repeat(64), byteSize: 3_100_000, mediaType: "text/html; charset=utf-8" });
    expect(JSON.stringify(built).length).toBeLessThan(800);
    expect(built).not.toHaveProperty("pages"); expect(built).not.toHaveProperty("sourceDocument"); expect(built).not.toHaveProperty("html");
    expect((await readPrototypeDraft(h.db, reference)).pages).toHaveLength(50);
    await commitPrototypeDraft(h.db, built);
    expect(h.revision.status).toBe("ready");
  });

  it("replays an identical pinned draft without rewrites and rejects a different generation", async () => {
    const h = harness(); const generated = { title: input.title, pages: [page(0)] };
    const first = await pinGeneratedPrototypeDraft(h.db, input, generated);
    expect(await pinGeneratedPrototypeDraft(h.db, input, generated)).toEqual(first);
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenCalledOnce();
    await expect(pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0, 101)] })).rejects.toThrow("PROTOTYPE_DRAFT_INTEGRITY_FAILURE");
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenCalledOnce();
  });

  it("detects mutated storage bytes before build or ready transition", async () => {
    const h = harness(); const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] });
    h.revision.pages[0]!.content = "tampered";
    await expect(readPrototypeDraft(h.db, reference)).rejects.toThrow("PROTOTYPE_DRAFT_INTEGRITY_FAILURE");
    await expect(commitPrototypeDraft(h.db, { ...reference, htmlSha256: "b".repeat(64), htmlByteSize: 100 })).rejects.toThrow("PROTOTYPE_DRAFT_INTEGRITY_FAILURE");
    expect(h.tx.prototypePlan.updateMany).not.toHaveBeenCalled();
  });

  it("does not resurrect a cancelled generation after the draft has been pinned", async () => {
    const h = harness(); const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] });
    const built = await recordPrototypeBuild(h.db, reference, { key: "prototype-v2/project/revision/preview.html", sha256: "b".repeat(64), byteSize: 100, mediaType: "text/html; charset=utf-8" });
    h.plan.status = "cancelled"; h.revision.status = "cancelled";
    await expect(readPrototypeDraft(h.db, reference)).rejects.toThrow("PROTOTYPE_DRAFT_NOT_ACTIVE");
    await expect(pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] })).rejects.toThrow("PROTOTYPE_DRAFT_NOT_ACTIVE");
    await expect(commitPrototypeDraft(h.db, built)).rejects.toThrow("PROTOTYPE_PLAN_NOT_ACTIVE");
    expect(h.revision.status).toBe("cancelled");
  });

  it("cannot become ready without a committed frozen-object manifest", async () => {
    const h = harness(); const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] });
    await expect(commitPrototypeDraft(h.db, { ...reference, artifactKey: "not-committed", htmlSha256: "b".repeat(64), htmlByteSize: 100, htmlMediaType: "text/html; charset=utf-8" })).rejects.toThrow("PROTOTYPE_BUILD_EVIDENCE_REQUIRED");
    expect(h.plan.status).toBe("generating"); expect(h.revision.status).toBe("generating");
  });

  it("replays an object manifest after a lost acknowledgement and rejects conflicting bytes", async () => {
    const h = harness(); const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] });
    const artifact = { key: "prototype-v2/project/revision/preview.html", sha256: "b".repeat(64), byteSize: 100, mediaType: "text/html; charset=utf-8" };
    const built = await recordPrototypeBuild(h.db, reference, artifact);
    expect(await recordPrototypeBuild(h.db, reference, artifact)).toEqual(built);
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenCalledTimes(2);
    await expect(recordPrototypeBuild(h.db, reference, { ...artifact, sha256: "c".repeat(64) })).rejects.toThrow("PROTOTYPE_BUILD_INTEGRITY_FAILURE");
  });

  it("commits a validated draft once without rewriting its immutable content", async () => {
    const h = harness(); const reference = await pinGeneratedPrototypeDraft(h.db, input, { title: input.title, pages: [page(0)] });
    const built = await recordPrototypeBuild(h.db, reference, { key: "prototype-v2/project/revision/preview.html", sha256: "b".repeat(64), byteSize: 100, mediaType: "text/html; charset=utf-8" });
    await commitPrototypeDraft(h.db, built); await commitPrototypeDraft(h.db, built);
    expect(h.tx.prototypePlan.updateMany).toHaveBeenCalledOnce();
    expect(h.tx.prototypeRevision.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { status: "ready", revision: { increment: 1 } } }));
  });
});

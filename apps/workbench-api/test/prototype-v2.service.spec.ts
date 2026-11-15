import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { PrototypeV2Service } from "../src/modules/prototypes/prototype-v2.service.js";

const now = new Date("2026-11-14T00:00:00.000Z");
const content = "<button>Open</button>";
const page = { id: "page_1", slug: "home", title: "Home", route: "/", order: 0, content, sha256: createHash("sha256").update(content).digest("hex") };
const frozenHtml = `<!doctype html><html><body data-prototype-revision="revision_1">${content}</body></html>`;
const revision = {
  builtArtifactKey: "private/frozen.html", builtArtifactByteSize: Buffer.byteLength(frozenHtml), builtArtifactMediaType: "text/html; charset=utf-8", builtArtifactSha256: createHash("sha256").update(frozenHtml).digest("hex"),
  id: "revision_1", projectId: "project_1", planId: "plan_1", createdById: "principal_1", version: 1, sourceRevisionId: null, revision: 1, status: "ready", title: "Demo", pages: [page], documentSha256: "b".repeat(64), sourceDocument: { private: "never public" },
  failureCode: null, failureDetail: null, createdAt: now, updatedAt: now,
};
const workflows = () => ({ configured: false, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() });
const config = { get: (key: string) => ({ WORKBENCH_PREVIEW_TOKEN_SECRET: "secret", WORKBENCH_WEB_ORIGIN: "https://workbench.test", WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "900" } as Record<string, string>)[key] };

describe("Prototype V2 public read boundaries", () => {
  it("binds preview authorization to the immutable revision and refuses tampering and changed content", async () => {
    let row = { ...revision };
    const db: any = { project: { findFirst: vi.fn().mockResolvedValue({ id: revision.projectId }) }, projectMember: { findFirst: vi.fn().mockResolvedValue({ role: "viewer" }) }, prototypeRevision: { findFirst: vi.fn(async () => row) } };
    let servedHtml = frozenHtml;
    const storage = { getObject: vi.fn(async () => ({ body: Readable.from(servedHtml), byteSize: revision.builtArtifactByteSize, sha256: revision.builtArtifactSha256, mediaType: revision.builtArtifactMediaType })) };
    const service = new PrototypeV2Service(db, workflows(), config as never, storage as never);
    const authorization = await service.createPreviewToken({ id: "principal_1" } as never, revision.projectId, revision.id);
    const token = authorization.url.split("/").at(-1)!;
    await expect(service.getPreviewHtml(token)).resolves.toMatchObject({ html: expect.stringContaining(`data-prototype-revision="${revision.id}"`) });
    await expect(service.getPreviewHtml(`${token}x`)).rejects.toMatchObject({ status: 404 });
    servedHtml = frozenHtml.replace("Save", "Wrong");
    if (servedHtml === frozenHtml) servedHtml = frozenHtml.replace("Open", "Wrong");
    await expect(service.getPreviewHtml(token)).rejects.toMatchObject({ status: 503 });
    row = { ...row, documentSha256: "c".repeat(64) };
    await expect(service.getPreviewHtml(token)).rejects.toMatchObject({ status: 404 });
  });

  it("does not expose private IR through direct revision recovery", async () => {
    const db: any = { projectMember: { findFirst: vi.fn().mockResolvedValue({ role: "viewer" }) }, prototypeRevision: { findFirst: vi.fn().mockResolvedValue(revision) } };
    const storage = { getObject: vi.fn(async () => ({ body: Readable.from(frozenHtml), byteSize: revision.builtArtifactByteSize, sha256: revision.builtArtifactSha256, mediaType: revision.builtArtifactMediaType })) };
    const service = new PrototypeV2Service(db, workflows(), config as never, storage as never);
    const result = await service.getRevision({ id: "principal_1" } as never, revision.projectId, revision.id);
    expect(result).not.toHaveProperty("sourceDocument");
    expect(result).not.toHaveProperty("builtArtifactKey");
    expect(result.previewHtml).toBe(frozenHtml);
    expect(result.pages).toEqual([page]);
  });

  it("returns no executable preview while pending and rejects corrupt frozen content", async () => {
    let row = { ...revision, status: "generating" };
    const db: any = { projectMember: { findFirst: vi.fn().mockResolvedValue({ role: "viewer" }) }, prototypeRevision: { findFirst: vi.fn(async () => row) } };
    const storage = { getObject: vi.fn(async () => ({ body: Readable.from(frozenHtml.replace("Open", "Shut")), byteSize: revision.builtArtifactByteSize, sha256: revision.builtArtifactSha256, mediaType: revision.builtArtifactMediaType })) };
    const service = new PrototypeV2Service(db, workflows(), config as never, storage as never);
    expect((await service.getRevision({ id: "principal_1" } as never, revision.projectId, revision.id)).previewHtml).toBeNull();
    expect(storage.getObject).not.toHaveBeenCalled();
    row = { ...revision, status: "ready" };
    await expect(service.getRevision({ id: "principal_1" } as never, revision.projectId, revision.id)).rejects.toMatchObject({ status: 503 });
  });

  it("rejects project reads and writes before revealing resource state", async () => {
    const db: any = { projectMember: { findFirst: vi.fn().mockResolvedValue(null) }, prototypeRevision: { findFirst: vi.fn() }, prototypePlan: { findMany: vi.fn() } };
    const service = new PrototypeV2Service(db, workflows(), config as never, {} as never);
    await expect(service.getRevision({ id: "outsider" } as never, revision.projectId, revision.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.listPlans({ id: "outsider" } as never, revision.projectId)).rejects.toMatchObject({ status: 403 });
    expect(db.prototypeRevision.findFirst).not.toHaveBeenCalled();
    expect(db.prototypePlan.findMany).not.toHaveBeenCalled();
  });

  it("rejects a download whose storage integrity manifest is missing", async () => {
    const row = { id: "export_1", projectId: "project_1", revisionId: "revision_1", status: "succeeded", artifactKey: "private/key.html", artifactSha256: "a".repeat(64), byteSize: 1, mediaType: "text/html; charset=utf-8" };
    const db: any = { projectMember: { findFirst: vi.fn().mockResolvedValue({ role: "viewer" }) }, prototypeExport: { findFirst: vi.fn().mockResolvedValue(row) } };
    const storage = { getObject: vi.fn().mockResolvedValue({ body: Buffer.from("x"), byteSize: 1, mediaType: null, sha256: null }) };
    const service = new PrototypeV2Service(db, workflows(), config as never, storage as never);
    await expect(service.getExportContent({ id: "principal_1" } as never, row.projectId, row.id)).rejects.toMatchObject({ status: 503 });
  });
});

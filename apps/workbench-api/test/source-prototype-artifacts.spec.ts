import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, type SourcePrototypeInput } from "@workbench/workbench-contracts";
import { buildSourcePrototype } from "@workbench/workbench-export-core";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service.js";
import { mapPublicArtifactVersion } from "../src/modules/shares/share.mapper.js";
import { artifactKnowledgeMarkdown } from "../src/modules/artifacts/artifact-knowledge-markdown.js";

const createdAt = new Date("2026-11-03T00:00:00.000Z");
const input = (): SourcePrototypeInput => ({ protocol: "workbench.prototype-source-input.v1", documentId: "source-001", title: "采购源码原型", revision: 1,
  summary: "申请人在采购页面填写申请并提交审批。", entryFile: "src/App.tsx",
  files: [{ path: "src/App.tsx", content: 'export default function App(){return <button>提交采购申请</button>}' }],
  pages: [{ id: "home", name: "采购申请", route: "/" }],
});

function database() {
  let pending: Record<string, unknown> = {};
  let ready: Record<string, unknown> = {};
  let artifact: Record<string, unknown> = {};
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
    artifactCreationReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    sourcePrototypeCreationReceipt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "source_receipt" }) },
    artifact: {
      create: vi.fn().mockResolvedValue({ id: "artifact_source" }),
      update: vi.fn().mockImplementation(async () => {
        artifact = { id: "artifact_source", projectId: "project_1", kind: "prototype", title: input().title, revision: 1,
          currentVersionId: "version_source", currentVersion: ready, createdAt, updatedAt: createdAt };
        return artifact;
      }),
    },
    artifactVersion: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        pending = { ...data, id: "version_source", contentBlobId: null, createdByRunId: null, knowledgeReleaseId: null, createdAt };
        return pending;
      }),
      update: vi.fn().mockImplementation(async () => {
        ready = { ...pending, status: "ready", contentBlob: null, artifact: { kind: "prototype" } };
        return ready;
      }),
    },
  };
  const db = {
    project: { findFirst: vi.fn().mockResolvedValue({ id: "project_1" }) },
    artifactCreationReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    sourcePrototypeCreationReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx, receipt: () => ({ createdById: "principal_1", requestHash: createHash("sha256").update(canonicalJson({ kind: "prototype", title: input().title, document: input() })).digest("hex"), artifact, artifactVersion: ready }) };
}

describe("source prototype artifacts", () => {
  it("builds trusted frozen HTML before atomically publishing an immutable source version and replays it", async () => {
    const { db, tx, receipt } = database();
    const service = new ArtifactsService(db as never, {} as never);
    const command = { kind: "prototype" as const, title: input().title, document: input() };
    const result = await service.create("principal_1", "project_1", "source:create-1", command);
    expect(result.artifact.kind).toBe("prototype");
    expect(result.artifactVersion).toMatchObject({ kind: "prototype", schemaVersion: 2, contentMode: "inline", status: "ready" });
    if (result.artifactVersion.contentMode !== "inline" || result.artifactVersion.kind !== "prototype" || result.artifactVersion.schemaVersion !== 2) throw new Error("source fixture");
    const document = result.artifactVersion.content;
    expect(document.build.htmlSha256).toBe(createHash("sha256").update(document.build.html).digest("hex"));
    expect(result.artifactVersion.checksum).toBe(createHash("sha256").update(canonicalJson(document)).digest("hex"));
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "staging", schemaVersion: 2, content: document }) });
    expect(tx.sourcePrototypeCreationReceipt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ artifactId: "artifact_source", artifactVersionId: "version_source", idempotencyKey: "source:create-1" }) });
    db.sourcePrototypeCreationReceipt.findUnique.mockResolvedValue(receipt());
    await expect(service.create("principal_1", "project_1", "source:create-1", command)).resolves.toEqual(result);
    expect(db.$transaction).toHaveBeenCalledOnce();
    await expect(service.create("principal_1", "project_1", "source:create-1", { ...command, document: { ...input(), summary: "changed" } })).rejects.toMatchObject({ status: 409 });
  });

  it("authorizes before compiling and never publishes a source that fails to build", async () => {
    const { db, tx } = database();
    const service = new ArtifactsService(db as never, {} as never);
    const bad = { ...input(), files: [{ path: "src/App.tsx", content: 'import fs from "node:fs"; export default function App(){return <p>{fs.readFileSync("x", "utf8")}</p>}' }] };
    db.project.findFirst.mockResolvedValueOnce(null);
    await expect(service.create("unauthorized", "project_1", "source:create-2", { kind: "prototype", title: bad.title, document: bad })).rejects.toMatchObject({ status: 404 });
    await expect(service.create("principal_1", "project_1", "source:create-2", { kind: "prototype", title: bad.title, document: bad })).rejects.toMatchObject({ status: 422 });
    expect(tx.artifact.create).not.toHaveBeenCalled();
    expect(tx.sourcePrototypeCreationReceipt.create).not.toHaveBeenCalled();
  });

  it("keeps image and source creations in the same project idempotency namespace", async () => {
    const { db } = database();
    db.artifactCreationReceipt.findUnique.mockResolvedValue({ id: "image_receipt" });
    const service = new ArtifactsService(db as never, {} as never);
    await expect(service.create("principal_1", "project_1", "shared:create-1", { kind: "prototype", title: input().title, document: input() })).rejects.toMatchObject({ status: 409 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rebuilds source edits under the existing revision and document-identity fences", async () => {
    const original = await buildSourcePrototype(input());
    let created: Record<string, unknown> = {};
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "artifact_source", projectId: "project_1", kind: "prototype", revision: 1, currentVersionId: "version_source" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      artifactVersionEditReceipt: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "edit_receipt" }) },
      artifactVersion: {
        findUnique: vi.fn().mockResolvedValue({ id: "version_source", artifactId: "artifact_source", projectId: "project_1", version: 1,
          schemaVersion: 2, status: "ready", content: original, contentBlobId: null, assets: [], citations: [], knowledgeReleaseId: null, sourcePrdVersionId: null }),
        findFirst: vi.fn().mockResolvedValue({ version: 1 }),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { created = { ...data, id: "version_source_2", contentBlobId: null, createdAt }; return created; }),
        update: vi.fn().mockImplementation(async () => ({ ...created, status: "ready", artifact: { kind: "prototype" } })),
      },
      artifact: { update: vi.fn().mockResolvedValue({ revision: 2 }) },
    };
    const db = { artifact: { findFirst: vi.fn().mockResolvedValue({ id: "artifact_source" }) },
      artifactVersionEditReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ArtifactsService(db as never, {} as never);
    const next = { ...input(), revision: 2, summary: "申请提交后进入主管审批。" };
    const command = { kind: "prototype" as const, baseArtifactVersionId: "version_source", document: next };
    await expect(service.createVersion("principal_1", "artifact_source", 0, "source:edit-stale", command)).rejects.toMatchObject({ status: 412 });
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    await expect(service.createVersion("principal_1", "artifact_source", 1, "source:edit-id-change", { ...command, document: { ...next, documentId: "different" } })).rejects.toMatchObject({ status: 409 });
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
    const result = await service.createVersion("principal_1", "artifact_source", 1, "source:edit-2", command);
    expect(result.artifactRevision).toBe(2);
    expect(result.detail).toMatchObject({ schemaVersion: 2, status: "ready", content: { documentId: original.documentId, revision: 2, summary: next.summary } });
    expect(tx.artifactVersionEditReceipt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ baseArtifactVersionId: "version_source", resultArtifactVersionId: "version_source_2", expectedArtifactRevision: 1, resultArtifactRevision: 2 }) });
  });

  it("publishes the pinned frozen view without raw source files and finalizes business semantics only", async () => {
    const document = await buildSourcePrototype(input());
    const checksum = createHash("sha256").update(canonicalJson(document)).digest("hex");
    const detail = mapPublicArtifactVersion({ id: "v1", artifactId: "a1", projectId: "p1", version: 1, schemaVersion: 2, status: "ready", content: document, checksum,
      citations: [], createdAt, contentBlob: null }, { position: 0, artifactId: "a1", artifactVersionId: "v1", title: document.title, kind: "prototype", version: 1, schemaVersion: 2, checksum, assets: [] });
    expect(detail).toMatchObject({ kind: "prototype", schemaVersion: 2, contentMode: "inline" });
    if (detail.contentMode !== "inline") throw new Error("source fixture");
    expect(detail.content).not.toHaveProperty("files");
    expect(detail.content).toHaveProperty("build.htmlSha256", document.build.htmlSha256);
    const markdown = artifactKnowledgeMarkdown(document.title, document);
    expect(markdown).toContain(document.summary);
    expect(markdown).toContain("采购申请");
    expect(markdown).not.toContain("export default");
    expect(markdown).not.toContain(document.build.html);
  });
});

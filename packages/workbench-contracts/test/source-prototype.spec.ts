import { describe, expect, it } from "vitest";
import {
  createArtifactRequestSchema,
  createArtifactVersionRequestSchema,
  sourcePrototypeInputSchema,
  sourcePrototypeDocumentSchema,
  projectPublicSourcePrototypeDocument,
  artifactVersionDetailSchema,
  type SourcePrototypeInput,
} from "../src/index.js";

const input = (): SourcePrototypeInput => ({
  protocol: "workbench.prototype-source-input.v1", documentId: "source-001", title: "采购原型", revision: 1,
  summary: "申请和审批两类业务状态。", entryFile: "src/App.tsx",
  files: [{ path: "src/App.tsx", content: "export default function App(){return <button>提交</button>}" }],
  pages: [{ id: "home", name: "采购申请", route: "/" }],
});

describe("source prototype boundary", () => {
  it("accepts bounded source input without accepting client-supplied build HTML", () => {
    expect(createArtifactRequestSchema.parse({ kind: "prototype", title: "采购原型", document: input() })).toBeTruthy();
    expect(createArtifactVersionRequestSchema.parse({ kind: "prototype", baseArtifactVersionId: "base-1", document: { ...input(), revision: 2 } })).toBeTruthy();
    expect(sourcePrototypeInputSchema.safeParse({ ...input(), build: { html: "<script>forged</script>" } }).success).toBe(false);
    expect(createArtifactRequestSchema.safeParse({ kind: "prototype", title: "different", document: input() }).success).toBe(false);
  });

  it.each(["../App.tsx", "/App.tsx", "src/../../App.tsx", "src\\App.tsx", "https://example.com/App.tsx", "node_modules/App.tsx", "src/.env", "src/run.sh"])("rejects unsafe virtual path %s", (path) => {
    expect(sourcePrototypeInputSchema.safeParse({ ...input(), entryFile: path, files: [{ path, content: "export default 1" }] }).success).toBe(false);
  });

  it("rejects duplicate paths, absent entry files, duplicate page identities and byte-budget overflow", () => {
    const original = input();
    expect(sourcePrototypeInputSchema.safeParse({ ...original, files: [...original.files, { ...original.files[0]!, path: "src/app.tsx" }] }).success).toBe(false);
    expect(sourcePrototypeInputSchema.safeParse({ ...original, entryFile: "src/Missing.tsx" }).success).toBe(false);
    expect(sourcePrototypeInputSchema.safeParse({ ...original, pages: [...original.pages, { id: "home", name: "重复", route: "/second" }] }).success).toBe(false);
    expect(sourcePrototypeInputSchema.safeParse({ ...original, files: [{ path: "src/App.tsx", content: "中".repeat(44_000) }] }).success).toBe(false);
    expect(sourcePrototypeInputSchema.safeParse({ ...original, files: Array.from({ length: 33 }, (_, i) => ({ path: `src/App${i}.tsx`, content: "" })) }).success).toBe(false);
    expect(sourcePrototypeInputSchema.safeParse({ ...original, files: Array.from({ length: 5 }, (_, i) => ({ path: i ? `src/App${i}.tsx` : original.entryFile, content: "x".repeat(128 * 1024) })) }).success).toBe(false);
  });

  it("separates public rendered documents from private source projects and legacy IR", () => {
    const { protocol: _protocol, ...source } = input();
    const document = sourcePrototypeDocumentSchema.parse({ ...source, protocol: "workbench.prototype-source.v1", build: {
      renderer: "workbench.react-source.v1", reactVersion: "19.2.3", bundlerVersion: "0.28.1",
      sourceChecksum: "a".repeat(64), html: "<!doctype html><title>采购原型</title>", htmlSha256: "b".repeat(64),
    } });
    expect(projectPublicSourcePrototypeDocument(document)).not.toHaveProperty("files");
    expect(projectPublicSourcePrototypeDocument(document).build).toEqual(document.build);
    const detail = { artifactId: "artifact-source", artifactVersionId: "version-source", version: 1, kind: "prototype", schemaVersion: 2,
      status: "ready", checksum: "c".repeat(64), citations: [], createdByRunId: null, knowledgeReleaseId: null,
      createdAt: "2026-11-03T00:00:00.000Z", contentMode: "inline", content: document };
    expect(artifactVersionDetailSchema.parse(detail).schemaVersion).toBe(2);
    expect(artifactVersionDetailSchema.safeParse({ ...detail, schemaVersion: 1 }).success).toBe(false);
    expect(artifactVersionDetailSchema.safeParse({ ...detail, contentMode: "blob", content: undefined, blob: { blobId: "b", mediaType: "application/json", byteSize: 1, sha256: "a".repeat(64), fileName: null } }).success).toBe(false);
  });
});

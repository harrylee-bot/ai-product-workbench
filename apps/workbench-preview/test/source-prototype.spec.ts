import { createHash } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import { createSourcePrototypePreviewToken } from "@workbench/workbench-preview-token";
import { describe, expect, it, vi } from "vitest";
import { PreviewService } from "../src/preview.service.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = Buffer.alloc(32, 13);
const html = '<!doctype html><html><head><style>body{margin:0}</style></head><body><div>Source content</div><script>window.ready=true</script></body></html>';
function fixture() {
  const content = { protocol: "workbench.prototype-source.v1", documentId: "source-1", title: "Source", revision: 1,
    summary: "Source prototype", entryFile: "src/App.tsx", files: [{ path: "src/App.tsx", content: 'export default function App(){return <p>Source content</p>}' }],
    pages: [{ id: "page-home", name: "Home", route: "/" }], assets: [],
    build: { renderer: "workbench.react-source.v1", reactVersion: "19.2.3", bundlerVersion: "0.28.1", sourceChecksum: "b".repeat(64), html, htmlSha256: digest(html) },
  };
  const checksum = digest(canonicalJson(content));
  const version = { projectId: "project-1", content, checksum };
  const db = { artifactVersion: { findFirst: vi.fn(async () => version) },
    projectMember: { findFirst: vi.fn(async () => ({ projectId: "project-1" })) },
    shareGrant: { findFirst: vi.fn(async () => ({ id: "share-1" })) } };
  const config = { tokenSecret: secret, tokenMaximumTtlSeconds: 3600, maximumHtmlBytes: 2 * 1024 * 1024, webOrigin: "https://workbench.test" };
  const storage = { stageHtml: vi.fn() };
  const service = new PreviewService(db as never, storage as never, config);
  const makeToken = (authorization: { principalId: string } | { shareId: string; shareRevision: number }) =>
    createSourcePrototypePreviewToken({ artifactId: "artifact-1", artifactVersionId: "version-1", checksum,
      expiresAt: new Date(Date.now() + 60_000), ...authorization }, secret);
  return { service, db, version, storage, makeToken };
}

describe("Frozen SourcePrototype isolated preview", () => {
  it("rechecks private membership and immutable content before serving, including conditional requests", async () => {
    const { service, db, makeToken } = fixture();
    const token = makeToken({ principalId: "viewer-1" });
    const preview = await service.get(token);
    expect(preview.contentSecurityPolicy).toContain("connect-src 'none'");
    expect(preview.contentSecurityPolicy).not.toContain("allow-same-origin");
    const chunks = []; for await (const chunk of preview.body) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    expect(body).toContain("Source content");
    expect(body).toContain("workbench.preview");
    await preview.dispose();
    db.projectMember.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.resolve(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
  });
  it("binds a public capability to the exact active shared version and revision", async () => {
    const { service, db, makeToken } = fixture();
    const token = makeToken({ shareId: "share-1", shareRevision: 4 });
    await service.resolve(token);
    expect(db.projectMember.findFirst).not.toHaveBeenCalled();
    expect(db.shareGrant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      id: "share-1", revision: 4, artifactVersionId: "version-1", status: "active", scope: "view",
    }) }));
    db.shareGrant.findFirst.mockResolvedValueOnce(null as never);
    await expect(service.resolve(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
  });
  it("rejects stored source or HTML drift even if a capability is authentic", async () => {
    const { service, version, makeToken } = fixture();
    const token = makeToken({ principalId: "viewer-1" });
    version.content.files[0]!.content = "changed";
    await expect(service.resolve(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
  });
});

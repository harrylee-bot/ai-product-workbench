import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { createPreviewToken } from "@workbench/workbench-preview-token";
import { describe, expect, it, vi } from "vitest";
import { PreviewService } from "../src/preview.service.js";

const secret = Buffer.alloc(32, 3);
const html = Buffer.from("<!doctype html><html><head><style>body{margin:0}</style></head><body><script>document.body.dataset.ready='yes'</script></body></html>");
const sha256 = createHash("sha256").update(html).digest("hex");

describe("PreviewService", () => {
  it.each(["export", "preview"] as const)("checks the %s token requester independently of the job creator", async (purpose) => {
    const members = new Set(["recipient"]);
    const db = {
      exportJob: { findFirst: vi.fn(async () => ({
        id: "export-1", purpose, createdById: "former-author",
        release: purpose === "export" ? { projectId: "project-1" } : null,
        preview: purpose === "preview" ? { projectId: "project-1" } : null,
        outputBlob: { storageKey: "blobs/output", mediaType: "text/html", byteSize: BigInt(html.byteLength), sha256 },
      })) },
      projectMember: { findFirst: vi.fn(async ({ where }) => members.has(where.principalId) ? { projectId: "project-1" } : null) },
    };
    const service = new PreviewService(db as never, previewStorage(html) as never, config());
    const token = createPreviewToken({ exportJobId: "export-1", principalId: "recipient", expiresAt: new Date(Date.now() + 60_000) }, secret);
    await expect(service.resolve(token)).resolves.toMatchObject({ capabilityToken: token });
    expect(db.projectMember.findFirst.mock.calls[0]![0].where.principalId).toBe("recipient");
    members.delete("recipient");
    members.add("former-author");
    await expect(service.resolve(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
  });

  it("keeps the existing creator check for unexpired legacy capabilities", async () => {
    const db = {
      exportJob: { findFirst: vi.fn(async () => ({
        id: "export-1", purpose: "preview", createdById: "legacy-author", release: null,
        preview: { projectId: "project-1" },
        outputBlob: { storageKey: "blobs/output", mediaType: "text/html", byteSize: BigInt(html.byteLength), sha256 },
      })) },
      projectMember: { findFirst: vi.fn(async () => ({ projectId: "project-1" })) },
    };
    const encoded = Buffer.from(JSON.stringify({ v: 1, exportJobId: "export-1", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const unsigned = `wbpv1.${encoded}`;
    const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
    await new PreviewService(db as never, previewStorage(html) as never, config()).resolve(token);
    expect(db.projectMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ principalId: "legacy-author" }),
    }));
  });
  it("resolves a valid capability only to a succeeded HTML Export Blob", async () => {
    const db = {
      exportJob: {
        findFirst: vi.fn(async () => ({
          id: "export-1",
          purpose: "export" as const,
          createdById: "principal-1",
          release: { projectId: "project-1" },
          preview: null,
          outputBlob: {
            storageKey: "blobs/aa/export/g1",
            mediaType: "text/html; charset=utf-8",
            byteSize: BigInt(html.byteLength),
            sha256,
          },
        })),
      },
      projectMember: {
        findFirst: vi.fn(async () => ({ projectId: "project-1" })),
      },
    };
    const storage = previewStorage(html);
    const service = new PreviewService(db as never, storage as never, config());
    const token = createPreviewToken({ exportJobId: "export-1", principalId: "principal-1", expiresAt: new Date(Date.now() + 60_000) }, secret);
    const result = await service.get(token);
    const rendered = await readAll(result.body);
    await result.dispose();
    expect(new TextDecoder().decode(rendered)).toContain("data-workbench-preview-bridge=\"v1\"");
    expect(rendered).not.toEqual(html);
    expect(result.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(result.etag).not.toBe(`"${sha256}"`);
    expect(result.contentSecurityPolicy).toContain("sandbox allow-scripts");
    expect(result.contentSecurityPolicy).not.toContain("allow-same-origin");
    expect(result.contentSecurityPolicy).toContain("script-src-elem 'sha256-");
    expect(db.exportJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "export-1",
        format: "html",
        status: "succeeded",
        OR: expect.arrayContaining([
          expect.objectContaining({
            purpose: "export",
            release: { is: { project: { is: { status: "active" } } } },
          }),
          expect.objectContaining({ purpose: "preview", release: null }),
        ]),
      }),
    }));
    expect(db.projectMember.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: "project-1",
        principalId: "principal-1",
        role: { in: ["owner", "editor"] },
        principal: { status: "active" },
      },
      select: { projectId: true },
    });
    expect(storage.stageHtml).toHaveBeenCalledWith(expect.objectContaining({ sha256 }), 1024 * 1024, undefined);
  });

  it("serves a private Preview from ProjectPreview when releaseId is null", async () => {
    const db = {
      exportJob: {
        findFirst: vi.fn(async () => ({
          id: "preview-export-1",
          purpose: "preview" as const,
          createdById: "viewer-1",
          release: null,
          preview: { projectId: "project-1" },
          outputBlob: {
            storageKey: "blobs/aa/preview/g1",
            mediaType: "text/html; charset=utf-8",
            byteSize: BigInt(html.byteLength),
            sha256,
          },
        })),
      },
      projectMember: {
        findFirst: vi.fn(async () => ({ projectId: "project-1" })),
      },
    };
    const storage = previewStorage(html);
    const service = new PreviewService(db as never, storage as never, config());
    const token = createPreviewToken({
      exportJobId: "preview-export-1", principalId: "viewer-1",
      expiresAt: new Date(Date.now() + 60_000),
    }, secret);

    const result = await service.get(token);
    expect(result).toMatchObject({
      etag: expect.stringMatching(/^"[a-f0-9]{64}"$/),
    });
    await result.dispose();
    expect(storage.stageHtml).toHaveBeenCalledOnce();
  });

  it("invalidates an already-issued Preview token after membership revocation", async () => {
    const db = {
      exportJob: {
        findFirst: vi.fn(async () => ({
          id: "preview-export-1",
          purpose: "preview" as const,
          createdById: "viewer-1",
          release: null,
          preview: { projectId: "project-1" },
          outputBlob: {
            storageKey: "blobs/aa/preview/g1",
            mediaType: "text/html; charset=utf-8",
            byteSize: BigInt(html.byteLength),
            sha256,
          },
        })),
      },
      projectMember: { findFirst: vi.fn(async () => null) },
    };
    const storage = { stageHtml: vi.fn() };
    const service = new PreviewService(db as never, storage as never, config());
    const token = createPreviewToken({
      exportJobId: "preview-export-1", principalId: "viewer-1",
      expiresAt: new Date(Date.now() + 60_000),
    }, secret);

    await expect(service.get(token)).rejects.toThrow("PREVIEW_NOT_FOUND");
    expect(storage.stageHtml).not.toHaveBeenCalled();
  });

  it("does not expose missing jobs or accept a token signed by another secret", async () => {
    const db = {
      exportJob: { findFirst: vi.fn(async () => null) },
      projectMember: { findFirst: vi.fn() },
    };
    const service = new PreviewService(db as never, { stageHtml: vi.fn() } as never, config());
    const valid = createPreviewToken({ exportJobId: "export-1", principalId: "principal-1", expiresAt: new Date(Date.now() + 60_000) }, secret);
    await expect(service.get(valid)).rejects.toThrow("PREVIEW_NOT_FOUND");
    const wrong = createPreviewToken({ exportJobId: "export-1", principalId: "principal-1", expiresAt: new Date(Date.now() + 60_000) }, Buffer.alloc(32, 4));
    await expect(service.get(wrong)).rejects.toThrow("PREVIEW_TOKEN_SIGNATURE_INVALID");
    expect(db.exportJob.findFirst).toHaveBeenCalledOnce();
  });
});

function config() {
  return {
    tokenSecret: secret,
    tokenMaximumTtlSeconds: 3_600,
    maximumHtmlBytes: 1024 * 1024,
    webOrigin: "https://workbench.example.com",
  };
}

function previewStorage(source: Buffer) {
  const decoded = source.toString("utf8");
  const headEndOffset = decoded.indexOf("<head>") + "<head>".length;
  const script = decoded.match(/<script>([\s\S]*?)<\/script>/u)?.[1] ?? "";
  const style = decoded.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
  return {
    stageHtml: vi.fn(async () => ({
      byteSize: source.byteLength,
      inspection: {
        headEndOffset,
        scriptSha256: [createHash("sha256").update(script).digest("base64")],
        styleSha256: [createHash("sha256").update(style).digest("base64")],
      },
      injectedStream(markup: string) {
        const insertionByteOffset = Buffer.byteLength(decoded.slice(0, headEndOffset));
        const bytes = Buffer.concat([
          source.subarray(0, insertionByteOffset),
          Buffer.from(markup),
          source.subarray(insertionByteOffset),
        ]);
        return { body: Readable.from([bytes]), byteSize: bytes.byteLength };
      },
      dispose: vi.fn(async () => undefined),
    })),
  };
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}

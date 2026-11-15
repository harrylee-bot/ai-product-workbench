import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

// Callers supply source classes in Vitest and compiled classes in browser smoke tests.
export async function renderPreviewHtmlFixture({ PreviewService, PreviewStorage, html, webOrigin, capabilityId }) {
  const source = Buffer.from(html, "utf8");
  const spoolDirectory = await mkdtemp(join(tmpdir(), "workbench-preview-fixture-"));
  let rendered;
  try {
    const identity = {
      storageKey: "preview-fixture.html",
      byteSize: source.byteLength,
      sha256: createHash("sha256").update(source).digest("hex"),
      mediaType: "text/html; charset=utf-8",
    };
    const storage = new PreviewStorage({ spoolDirectory, s3Bucket: "preview-fixture" }, async () => undefined, {
      send: async () => ({ Body: Readable.from([source]), ContentLength: source.byteLength, ContentType: identity.mediaType }),
    });
    const service = new PreviewService(null, storage, { webOrigin, maximumHtmlBytes: source.byteLength });
    rendered = await service.render({ identity, capabilityToken: capabilityId, etag: '"fixture"' });
    const chunks = [];
    for await (const chunk of rendered.body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    return { bytes, html: bytes.toString("utf8"), contentSecurityPolicy: rendered.contentSecurityPolicy };
  } finally {
    rendered?.body.destroy();
    try { await rendered?.dispose(); }
    finally { await rm(spoolDirectory, { recursive: true, force: true }); }
  }
}

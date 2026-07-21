import { createHash } from "node:crypto";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewStorage } from "../src/storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PreviewStorage bounded staging", () => {
  it("verifies, inspects, injects, and removes a staged HTML object", async () => {
    const source = Buffer.from(
      "\uFEFF<!--产品--><!doctype html><html><head><style>body{color:#111}</style></head><body>产品工作台<script>window.ready=true</script></body></html>",
    );
    const chineseOffset = source.indexOf(Buffer.from("产"));
    const body = Readable.from([
      source.subarray(0, chineseOffset + 1),
      source.subarray(chineseOffset + 1, chineseOffset + 2),
      source.subarray(chineseOffset + 2),
    ]);
    const { storage, spoolDirectory } = await storageFor(source.byteLength, body);
    const staged = await storage.stageHtml(identity(source), 1024 * 1024);

    expect(staged.inspection.scriptSha256).toEqual([
      createHash("sha256").update("window.ready=true").digest("base64"),
    ]);
    expect(staged.inspection.styleSha256).toEqual([
      createHash("sha256").update("body{color:#111}").digest("base64"),
    ]);
    const injection = "<script data-test-bridge>window.bridge=true</script>";
    const rendered = await readAll(staged.injectedStream(injection).body);
    expect(rendered.toString("utf8")).toBe(
      source.toString("utf8").replace("<head>", `<head>${injection}`),
    );

    await staged.dispose();
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("fails closed and removes the spool file when the trusted digest does not match", async () => {
    const source = Buffer.from("<!doctype html><html><head></head><body>tampered</body></html>");
    let recorderResolved = false;
    const recordIntegrityFailure = vi.fn(async () => {
      await Promise.resolve();
      recorderResolved = true;
    });
    const { storage, spoolDirectory } = await storageFor(
      source.byteLength,
      Readable.from([source]),
      recordIntegrityFailure,
    );

    await expect(storage.stageHtml({
      ...identity(source),
      sha256: "0".repeat(64),
    }, 1024 * 1024)).rejects.toThrow("OBJECT_STORAGE_SHA256_MISMATCH");
    expect(recorderResolved).toBe(true);
    expect(recordIntegrityFailure).toHaveBeenCalledOnce();
    expect(recordIntegrityFailure).toHaveBeenCalledWith(expect.objectContaining({
      failureCode: "OBJECT_STORAGE_SHA256_MISMATCH",
      storageKey: "blobs/preview/source",
    }));
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("rejects a source-defined bridge marker before opening a response stream", async () => {
    const source = Buffer.from(
      '<!doctype html><html><head></head><body data-workbench-preview-bridge="v1"></body></html>',
    );
    const { storage, spoolDirectory } = await storageFor(source.byteLength, Readable.from([source]));

    await expect(storage.stageHtml(identity(source), 1024 * 1024))
      .rejects.toThrow("PREVIEW_BRIDGE_MARKER_CONFLICT");
    expect(await readdir(spoolDirectory)).toEqual([]);
  });

  it("stages and streams a 50 MiB representation below a 64 MiB heap-growth ceiling", async () => {
    const totalBytes = 50 * 1024 * 1024;
    const prefix = Buffer.from("<!doctype html><html><head><style>body{margin:0}</style></head><body>");
    const suffix = Buffer.from("</body></html>");
    const fillerBytes = totalBytes - prefix.byteLength - suffix.byteLength;
    const filler = Buffer.alloc(64 * 1024, 0x78);
    const digest = createHash("sha256").update(prefix);
    for (let remaining = fillerBytes; remaining > 0; remaining -= Math.min(remaining, filler.byteLength)) {
      digest.update(filler.subarray(0, Math.min(remaining, filler.byteLength)));
    }
    digest.update(suffix);
    const body = Readable.from(largeHtmlChunks(prefix, filler, fillerBytes, suffix));
    const { storage } = await storageFor(totalBytes, body);
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }, 1);

    try {
      const staged = await storage.stageHtml({
        storageKey: "blobs/preview/large",
        byteSize: totalBytes,
        sha256: digest.digest("hex"),
        mediaType: "text/html; charset=utf-8",
      }, totalBytes);
      const transformed = staged.injectedStream("<script>window.bridge=true</script>");
      let emitted = 0;
      for await (const chunk of transformed.body) emitted += Buffer.byteLength(chunk);
      expect(emitted).toBe(transformed.byteSize);
      expect(transformed.byteSize).toBeGreaterThan(totalBytes);
      await staged.dispose();
    } finally {
      clearInterval(sampler);
    }
    expect(peak - baseline).toBeLessThan(64 * 1024 * 1024);
  }, 30_000);
});

async function storageFor(
  contentLength: number,
  body: Readable,
  recordIntegrityFailure = vi.fn(async () => undefined),
) {
  const spoolDirectory = await mkdtemp(join(tmpdir(), "workbench-preview-storage-test-"));
  roots.push(spoolDirectory);
  const client = {
    send: vi.fn(async () => ({
      Body: body,
      ContentLength: contentLength,
      ContentType: "text/html; charset=utf-8",
    })),
  };
  return {
    spoolDirectory,
    storage: new PreviewStorage({
      s3Bucket: "workbench",
      s3Region: "us-east-1",
      s3InternalEndpoint: "http://127.0.0.1:9000",
      s3ForcePathStyle: true,
      previewS3AccessKeyId: "preview-access",
      previewS3SecretAccessKey: "preview-secret",
      spoolDirectory,
    }, recordIntegrityFailure, client as never),
  };
}

function identity(source: Buffer) {
  return {
    storageKey: "blobs/preview/source",
    byteSize: source.byteLength,
    sha256: createHash("sha256").update(source).digest("hex"),
    mediaType: "text/html; charset=utf-8",
  };
}

async function *largeHtmlChunks(
  prefix: Buffer,
  filler: Buffer,
  fillerBytes: number,
  suffix: Buffer,
) {
  yield prefix;
  let iteration = 0;
  for (let remaining = fillerBytes; remaining > 0; remaining -= Math.min(remaining, filler.byteLength)) {
    yield filler.subarray(0, Math.min(remaining, filler.byteLength));
    iteration += 1;
    if (iteration % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  yield suffix;
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PreviewConfig } from "./config.js";
import {
  WorkbenchPreviewHtmlInspector,
  type WorkbenchPreviewHtmlInspection,
} from "./preview-bridge.js";

type S3Reader = Pick<S3Client, "send">;
type PreviewBlobIdentity = {
  storageKey: string;
  byteSize: number;
  sha256: string;
  mediaType: string;
};

export class StagedPreviewHtml {
  private claimed = false;
  private disposed = false;

  constructor(
    private readonly directory: string,
    private readonly filePath: string,
    readonly byteSize: number,
    readonly inspection: WorkbenchPreviewHtmlInspection,
  ) {}

  injectedStream(markup: string, signal?: AbortSignal) {
    if (this.claimed || this.disposed) throw new Error("PREVIEW_STAGE_NOT_AVAILABLE");
    this.claimed = true;
    const markupBytes = Buffer.from(markup, "utf8");
    return {
      body: Readable.from(this.injectedChunks(markupBytes, signal)),
      byteSize: this.byteSize + markupBytes.byteLength,
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.directory, { recursive: true, force: true });
  }

  private async *injectedChunks(markup: Buffer, signal?: AbortSignal) {
    const source = createReadStream(this.filePath, { highWaterMark: 64 * 1024, signal });
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let characterOffset = 0;
    let emittedBytes = 0;
    let injected = false;
    try {
      for await (const value of source) {
        assertNotAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const decoded = decoder.decode(chunk, { stream: true });
        const output = injectIntoDecodedChunk(
          decoded,
          characterOffset,
          this.inspection.headEndOffset,
          injected ? null : markup,
        );
        characterOffset += decoded.length;
        injected ||= output.injected;
        for (const part of output.parts) {
          emittedBytes += part.byteLength;
          yield part;
        }
      }
      const tail = decoder.decode();
      const output = injectIntoDecodedChunk(
        tail,
        characterOffset,
        this.inspection.headEndOffset,
        injected ? null : markup,
      );
      injected ||= output.injected;
      for (const part of output.parts) {
        emittedBytes += part.byteLength;
        yield part;
      }
      if (!injected || emittedBytes !== this.byteSize + markup.byteLength) {
        throw new Error("PREVIEW_TRANSFORM_SIZE_MISMATCH");
      }
    } finally {
      source.destroy();
    }
  }
}

export class PreviewStorage {
  private readonly client: S3Reader;

  constructor(
    private readonly config: Pick<
      PreviewConfig,
      | "s3Bucket"
      | "s3Region"
      | "s3InternalEndpoint"
      | "s3ForcePathStyle"
      | "previewS3AccessKeyId"
      | "previewS3SecretAccessKey"
      | "spoolDirectory"
    >,
    client?: S3Reader,
  ) {
    this.client = client ?? new S3Client({
      region: config.s3Region,
      ...(config.s3InternalEndpoint ? { endpoint: config.s3InternalEndpoint } : {}),
      forcePathStyle: config.s3ForcePathStyle,
      credentials: {
        accessKeyId: config.previewS3AccessKeyId,
        secretAccessKey: config.previewS3SecretAccessKey,
      },
    });
  }

  async stageHtml(identity: PreviewBlobIdentity, maximumBytes: number, signal?: AbortSignal) {
    if (identity.byteSize <= 0 || identity.byteSize > maximumBytes) {
      throw new Error("PREVIEW_BLOB_SIZE_INVALID");
    }
    await mkdir(this.config.spoolDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.config.spoolDirectory, "request-"));
    const filePath = join(directory, "source.html");
    const file = await open(filePath, "wx", 0o600);
    let fileClosed = false;
    let retained = false;
    let body: Readable | null = null;
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.s3Bucket, Key: identity.storageKey }),
        signal ? { abortSignal: signal } : undefined,
      );
      body = result.Body instanceof Readable ? result.Body : null;
      if (!body || result.ContentLength !== identity.byteSize || result.ContentType !== identity.mediaType) {
        throw new Error("PREVIEW_STORAGE_IDENTITY_MISMATCH");
      }

      const digest = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const inspector = new WorkbenchPreviewHtmlInspector();
      let byteSize = 0;
      for await (const value of body) {
        assertNotAborted(signal);
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteSize += chunk.byteLength;
        if (byteSize > identity.byteSize || byteSize > maximumBytes) {
          throw new Error("PREVIEW_STORAGE_IDENTITY_MISMATCH");
        }
        digest.update(chunk);
        await writeComplete(file, chunk);
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded) await inspector.write(decoded);
      }
      const tail = decoder.decode();
      if (tail) await inspector.write(tail);
      const inspection = await inspector.finish();
      if (byteSize !== identity.byteSize || digest.digest("hex") !== identity.sha256) {
        throw new Error("PREVIEW_STORAGE_IDENTITY_MISMATCH");
      }
      await file.close();
      fileClosed = true;
      retained = true;
      return new StagedPreviewHtml(directory, filePath, byteSize, inspection);
    } finally {
      body?.destroy();
      if (!fileClosed) await file.close().catch(() => undefined);
      if (!retained) await rm(directory, { recursive: true, force: true });
    }
  }
}

function injectIntoDecodedChunk(
  value: string,
  characterOffset: number,
  insertionOffset: number,
  markup: Buffer | null,
) {
  if (!markup || insertionOffset < characterOffset || insertionOffset > characterOffset + value.length) {
    return { injected: false, parts: value ? [Buffer.from(value, "utf8")] : [] };
  }
  const relativeOffset = insertionOffset - characterOffset;
  const before = Buffer.from(value.slice(0, relativeOffset), "utf8");
  const after = Buffer.from(value.slice(relativeOffset), "utf8");
  return {
    injected: true,
    parts: [before, markup, after].filter((part) => part.byteLength > 0),
  };
}

async function writeComplete(file: Awaited<ReturnType<typeof open>>, value: Buffer) {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("PREVIEW_STAGE_WRITE_FAILED");
    offset += bytesWritten;
  }
}

function assertNotAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("PREVIEW_CLIENT_DISCONNECTED");
}

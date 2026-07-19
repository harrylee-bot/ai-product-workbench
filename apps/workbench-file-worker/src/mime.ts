import { fileTypeFromBuffer } from "file-type";

const MIME_PREFIX_BYTES = 8 * 1024;

export class MimePrefixCollector {
  private readonly chunks: Buffer[] = [];
  private byteSize = 0;

  append(chunk: Uint8Array) {
    if (this.byteSize >= MIME_PREFIX_BYTES) return;
    const remaining = MIME_PREFIX_BYTES - this.byteSize;
    const slice = Buffer.from(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, remaining));
    this.chunks.push(Buffer.from(slice));
    this.byteSize += slice.byteLength;
  }

  async detect() {
    const prefix = Buffer.concat(this.chunks, this.byteSize);
    try {
      const binary = await fileTypeFromBuffer(prefix);
      if (binary) return binary.mime;
    } catch {
      // Truncated or unsupported signatures are still classified
      // conservatively below; parser exceptions never trust a declaration.
    }
    return detectTextMediaType(prefix);
  }
}

function detectTextMediaType(prefix: Buffer) {
  if (prefix.includes(0)) return "application/octet-stream";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch {
    return "application/octet-stream";
  }
  const sample = text.trimStart().toLowerCase();
  if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) return "text/html";
  if (sample.startsWith("<?xml")) return "application/xml";
  if (sample.startsWith("<svg") || sample.includes("<svg ")) return "image/svg+xml";

  let controls = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) controls += 1;
  }
  return controls > Math.max(1, text.length / 100) ? "application/octet-stream" : "text/plain";
}

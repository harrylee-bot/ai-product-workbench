import { PassThrough } from "node:stream";
import { ZipArchive } from "archiver";
import { TerminalExportError } from "./errors.js";

export type ArchiveEntry = {
  name: string;
  content: string | Uint8Array;
  mode?: number;
};

export async function createDeterministicZip(entries: ArchiveEntry[], maximumBytes = 50 * 1024 * 1024) {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!validArchiveName(entry.name) || names.has(entry.name)) {
      throw new TerminalExportError("EXPORT_ARCHIVE_ENTRY_INVALID", `Invalid or duplicate archive entry: ${entry.name}`);
    }
    names.add(entry.name);
  }

  const output = new PassThrough();
  const archive = new ZipArchive({ zlib: { level: 9 }, forceLocalTime: false });
  const chunks: Buffer[] = [];
  let byteSize = 0;
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => {
      byteSize += chunk.byteLength;
      if (byteSize > maximumBytes) {
        archive.abort();
        reject(new TerminalExportError("EXPORT_OUTPUT_SIZE_LIMIT_EXCEEDED", "Export archive exceeded its byte limit"));
        return;
      }
      chunks.push(chunk);
    });
    output.once("end", () => resolve(Buffer.concat(chunks, byteSize)));
    output.once("error", reject);
    archive.once("error", reject);
    archive.once("warning", reject);
  });
  archive.pipe(output);

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const content = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    archive.append(content, {
      name: entry.name,
      date: new Date(0),
      mode: entry.mode ?? 0o644,
    });
  }
  await archive.finalize();
  return completed;
}

function validArchiveName(value: string) {
  return value.length > 0
    && value.length <= 500
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !value.includes("\0");
}

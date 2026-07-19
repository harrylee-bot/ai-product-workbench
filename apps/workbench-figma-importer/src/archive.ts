import {
  figmaExportDocumentSchema,
  type FigmaExportDocument,
} from "@workbench/workbench-contracts/figma-export";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Unzip, UnzipInflate } from "fflate";

import { figmaImportAssetKey, type FigmaImportPayload } from "./types";

const JSON_ENTRY = "figma-export.json";

/** Limits are applied to ZIP metadata before any decompression starts. */
export const FIGMA_IMPORT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 10_001,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 100,
});

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const ZIP_COMMENT_MAX_BYTES = 65_535;

type ZipEntry = {
  name: string;
  compression: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
};

export class FigmaImportArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FigmaImportArchiveError";
  }
}

export async function parseFigmaExportArchive(
  input: ArrayBuffer | Uint8Array,
): Promise<FigmaImportPayload> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) throw new FigmaImportArchiveError("EMPTY_ARCHIVE", "ZIP 文件为空");
  if (bytes.byteLength > FIGMA_IMPORT_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new FigmaImportArchiveError("ARCHIVE_TOO_LARGE", "ZIP 文件超过产品工作台 Importer 的大小限制");
  }

  const entries = parseCentralDirectory(bytes);
  const documentEntry = entries.get(JSON_ENTRY);
  if (!documentEntry) {
    throw new FigmaImportArchiveError("MISSING_DOCUMENT", "导入包缺少 figma-export.json");
  }

  // Read the small contract entry first. Non-selected entries are never inflated.
  const documentBytes = (await extractEntries(bytes, entries, new Set([JSON_ENTRY]))).get(JSON_ENTRY);
  if (!documentBytes) {
    throw new FigmaImportArchiveError("MISSING_DOCUMENT", "导入包缺少 figma-export.json");
  }
  const document = parseDocument(documentBytes);

  const expectedAssetPaths = new Set(document.assets.map((asset) => asset.archivePath));
  const expectedEntries = new Set([JSON_ENTRY, ...expectedAssetPaths]);
  for (const entry of entries.values()) {
    if (!expectedEntries.has(entry.name)) {
      throw new FigmaImportArchiveError("UNEXPECTED_ENTRY", `导入包包含合同未声明的文件 ${entry.name}`);
    }
  }
  for (const assetPath of expectedAssetPaths) {
    if (!entries.has(assetPath)) {
      throw new FigmaImportArchiveError("MISSING_ASSET", `导入包缺少资产 ${assetPath}`);
    }
  }

  const assets: Record<string, Uint8Array> = {};
  const assetBytesByPath = expectedAssetPaths.size === 0
    ? new Map<string, Uint8Array>()
    : await extractEntries(bytes, entries, expectedAssetPaths);
  for (const asset of document.assets) {
    const assetBytes = assetBytesByPath.get(asset.archivePath);
    if (!assetBytes) {
      throw new FigmaImportArchiveError("MISSING_ASSET", `导入包缺少资产 ${asset.archivePath}`);
    }
    if (assetBytes.byteLength !== asset.byteSize) {
      throw new FigmaImportArchiveError(
        "ASSET_SIZE_MISMATCH",
        `资产 ${asset.assetId} 的大小与合同不一致`,
      );
    }
    const digest = await sha256Hex(assetBytes);
    if (digest !== asset.sha256) {
      throw new FigmaImportArchiveError(
        "ASSET_HASH_MISMATCH",
        `资产 ${asset.assetId} 的 SHA-256 校验失败`,
      );
    }
    assets[figmaImportAssetKey(asset.artifactVersionId, asset.assetId)] = assetBytes.slice();
  }

  return { document, assets };
}

export function parseFigmaExportDocument(value: unknown): FigmaExportDocument {
  const parsed = figmaExportDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new FigmaImportArchiveError(
      "INVALID_DOCUMENT_CONTRACT",
      "figma-export.json 不符合产品工作台 Figma 导出合同",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function verifyFigmaImportPayload(payload: FigmaImportPayload): Promise<FigmaImportPayload> {
  const document = parseFigmaExportDocument(payload.document);
  const assets: Record<string, Uint8Array> = {};
  for (const asset of document.assets) {
    const assetBytes = payload.assets[figmaImportAssetKey(asset.artifactVersionId, asset.assetId)];
    if (!assetBytes) {
      throw new FigmaImportArchiveError("MISSING_ASSET", `缺少资产 ${asset.assetId}`);
    }
    if (assetBytes.byteLength !== asset.byteSize) {
      throw new FigmaImportArchiveError("ASSET_SIZE_MISMATCH", `资产 ${asset.assetId} 大小不一致`);
    }
    if (await sha256Hex(assetBytes) !== asset.sha256) {
      throw new FigmaImportArchiveError("ASSET_HASH_MISMATCH", `资产 ${asset.assetId} SHA-256 不一致`);
    }
    assets[figmaImportAssetKey(asset.artifactVersionId, asset.assetId)] = assetBytes.slice();
  }
  return { document, assets };
}

function parseCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  try {
    if (bytes.byteLength < EOCD_MIN_BYTES) throw invalidZip("ZIP 头不完整");
    const eocdOffset = findEndOfCentralDirectory(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const diskNumber = readU16(view, eocdOffset + 4);
    const centralDisk = readU16(view, eocdOffset + 6);
    const entriesOnDisk = readU16(view, eocdOffset + 8);
    const entryCount = readU16(view, eocdOffset + 10);
    const centralSize = readU32(view, eocdOffset + 12);
    const centralOffset = readU32(view, eocdOffset + 16);
    const commentLength = readU16(view, eocdOffset + 20);

    if (eocdOffset + EOCD_MIN_BYTES + commentLength !== bytes.byteLength) {
      throw invalidZip("ZIP 结束记录不完整");
    }
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      throw unsupportedZip("不支持多磁盘 ZIP");
    }
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw unsupportedZip("不支持 ZIP64");
    }
    if (entryCount > FIGMA_IMPORT_ARCHIVE_LIMITS.maxEntries) {
      throw new FigmaImportArchiveError("ARCHIVE_ENTRY_LIMIT", "ZIP 文件条目数量超过限制");
    }
    if (centralOffset + centralSize > eocdOffset || centralOffset + centralSize > bytes.byteLength) {
      throw invalidZip("ZIP 中央目录越界");
    }

    const entries = new Map<string, ZipEntry>();
    let cursor = centralOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > bytes.byteLength || readU32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw invalidZip("ZIP 中央目录条目无效");
      }
      const flags = readU16(view, cursor + 8);
      const compression = readU16(view, cursor + 10);
      const compressedSize = readU32(view, cursor + 20);
      const uncompressedSize = readU32(view, cursor + 24);
      const nameLength = readU16(view, cursor + 28);
      const extraLength = readU16(view, cursor + 30);
      const entryCommentLength = readU16(view, cursor + 32);
      const localOffset = readU32(view, cursor + 42);
      const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (recordEnd > bytes.byteLength || recordEnd > centralOffset + centralSize) {
        throw invalidZip("ZIP 中央目录条目越界");
      }
      if ((flags & 0x0001) !== 0) throw unsupportedZip("不支持加密 ZIP");
      if (compression !== 0 && compression !== 8) throw unsupportedZip("ZIP 仅支持 stored/deflate");
      if (compressedSize === 0 && uncompressedSize !== 0) {
        throw new FigmaImportArchiveError("ARCHIVE_COMPRESSION_RATIO", "ZIP 压缩比超过限制");
      }
      if (uncompressedSize > FIGMA_IMPORT_ARCHIVE_LIMITS.maxEntryUncompressedBytes) {
        throw new FigmaImportArchiveError("ARCHIVE_ENTRY_TOO_LARGE", "ZIP 单项解压大小超过限制");
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > FIGMA_IMPORT_ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
        throw new FigmaImportArchiveError("ARCHIVE_TOTAL_UNCOMPRESSED_TOO_LARGE", "ZIP 总解压大小超过限制");
      }
      if (uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > FIGMA_IMPORT_ARCHIVE_LIMITS.maxCompressionRatio) {
        throw new FigmaImportArchiveError("ARCHIVE_COMPRESSION_RATIO", "ZIP 压缩比超过限制");
      }

      const name = decodeEntryName(bytes.subarray(cursor + 46, cursor + 46 + nameLength), (flags & 0x0800) !== 0);
      if (!name || name.endsWith("/") || name.includes("\0")) throw invalidZip("ZIP 条目名称无效");
      if (entries.has(name)) throw new FigmaImportArchiveError("DUPLICATE_ENTRY", `ZIP 条目重复: ${name}`);

      if (localOffset + 30 > bytes.byteLength || readU32(view, localOffset) !== LOCAL_FILE_SIGNATURE) {
        throw invalidZip("ZIP 本地文件头无效");
      }
      const localNameLength = readU16(view, localOffset + 26);
      const localExtraLength = readU16(view, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedSize > bytes.byteLength || dataOffset + compressedSize > centralOffset) {
        throw invalidZip("ZIP 压缩数据越界");
      }

      entries.set(name, {
        name,
        compression: compression as 0 | 8,
        compressedSize,
        uncompressedSize,
        dataOffset,
      });
      cursor = recordEnd;
    }
    if (cursor !== centralOffset + centralSize) throw invalidZip("ZIP 中央目录长度不一致");
    return entries;
  } catch (error) {
    if (error instanceof FigmaImportArchiveError) throw error;
    throw new FigmaImportArchiveError("INVALID_ZIP", "无法读取 Figma 导入包 ZIP 中央目录", { cause: error });
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.byteLength - EOCD_MIN_BYTES - ZIP_COMMENT_MAX_BYTES);
  for (let offset = bytes.byteLength - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (readU32(view, offset) === EOCD_SIGNATURE) return offset;
  }
  throw invalidZip("ZIP 缺少结束记录");
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  try {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // Contract paths are ASCII. Rejecting non-UTF8/legacy code pages avoids ambiguous aliases.
    if (!utf8 && /[^\x00-\x7f]/.test(name)) throw new Error("legacy filename encoding");
    return name;
  } catch (cause) {
    throw new FigmaImportArchiveError("INVALID_ZIP", "ZIP 条目名称不是有效 UTF-8", { cause });
  }
}

async function extractEntries(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  wanted: Set<string>,
): Promise<Map<string, Uint8Array>> {
  if (wanted.size === 0) return new Map();
  return new Promise((resolve, reject) => {
    const output = new Map<string, Uint8Array>();
    let inputDone = false;
    let pending = 0;
    let settled = false;
    const activeFiles = new Set<{ terminate(): void }>();
    const finish = () => {
      if (!settled && inputDone && pending === 0) {
        settled = true;
        resolve(output);
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      for (const file of activeFiles) {
        try {
          file.terminate();
        } catch {
          // Best effort: the original archive error is the useful diagnostic.
        }
      }
      reject(error instanceof FigmaImportArchiveError
        ? error
        : new FigmaImportArchiveError("INVALID_ZIP", "无法解压 Figma 导入包", { cause: error }));
    };

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      if (!wanted.has(file.name)) return;
      const metadata = entries.get(file.name);
      if (!metadata) {
        fail(new FigmaImportArchiveError("UNEXPECTED_ENTRY", `导入包包含合同未声明的文件 ${file.name}`));
        return;
      }
      pending += 1;
      activeFiles.add(file);
      const chunks: Uint8Array[] = [];
      let outputBytes = 0;
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail(new FigmaImportArchiveError("INVALID_ZIP", `无法解压 ${file.name}`, { cause: error }));
          return;
        }
        const current = chunk ?? new Uint8Array();
        outputBytes += current.byteLength;
        if (outputBytes > metadata.uncompressedSize || outputBytes > FIGMA_IMPORT_ARCHIVE_LIMITS.maxEntryUncompressedBytes) {
          fail(new FigmaImportArchiveError("ARCHIVE_ENTRY_TOO_LARGE", `ZIP 条目 ${file.name} 解压大小超过限制`));
          return;
        }
        if (current.byteLength > 0) chunks.push(current.slice());
        if (final) {
          if (file.size !== undefined && file.size !== metadata.compressedSize) {
            fail(new FigmaImportArchiveError("ARCHIVE_SIZE_MISMATCH", `ZIP 条目 ${file.name} 压缩大小不一致`));
            return;
          }
          if (file.originalSize !== undefined && file.originalSize !== metadata.uncompressedSize) {
            fail(new FigmaImportArchiveError("ARCHIVE_SIZE_MISMATCH", `ZIP 条目 ${file.name} 解压大小不一致`));
            return;
          }
          if (outputBytes !== metadata.uncompressedSize) {
            fail(new FigmaImportArchiveError("ARCHIVE_SIZE_MISMATCH", `ZIP 条目 ${file.name} 解压大小不一致`));
            return;
          }
          output.set(file.name, concatenate(chunks, outputBytes));
          pending -= 1;
          activeFiles.delete(file);
          finish();
        }
      };
      try {
        file.start();
      } catch (error) {
        fail(new FigmaImportArchiveError("INVALID_ZIP", `无法解压 ${file.name}`, { cause: error }));
      }
    };
    try {
      unzip.push(bytes, true);
      inputDone = true;
      finish();
    } catch (error) {
      fail(new FigmaImportArchiveError("INVALID_ZIP", "无法解压 Figma 导入包", { cause: error }));
    }
  });
}

function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function parseDocument(bytes: Uint8Array): FigmaExportDocument {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new FigmaImportArchiveError("INVALID_DOCUMENT_ENCODING", "figma-export.json 不是有效 UTF-8", { cause });
  }
  try {
    return parseFigmaExportDocument(JSON.parse(text) as unknown);
  } catch (cause) {
    if (cause instanceof FigmaImportArchiveError) throw cause;
    throw new FigmaImportArchiveError("INVALID_DOCUMENT_JSON", "figma-export.json 不是有效 JSON", { cause });
  }
}

function invalidZip(message: string): FigmaImportArchiveError {
  return new FigmaImportArchiveError("INVALID_ZIP", message);
}

function unsupportedZip(message: string): FigmaImportArchiveError {
  return new FigmaImportArchiveError("UNSUPPORTED_ZIP", message);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(sha256(bytes));
}

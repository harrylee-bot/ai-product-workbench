import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  FIGMA_IMPORT_ARCHIVE_LIMITS,
  parseFigmaExportArchive,
  verifyFigmaImportPayload,
} from "../src/archive";
import { exportFixture } from "./fixtures";

describe("产品工作台 Figma export archive", () => {
  it("unzips and validates the versioned document entry", async () => {
    const document = exportFixture();
    const archive = zipSync({
      "figma-export.json": strToU8(JSON.stringify(document)),
    });

    const payload = await parseFigmaExportArchive(archive);

    expect(payload.document.protocol).toBe("workbench.figma-export.v1");
    expect(payload.document.prototypes[0]?.selectedScreenIds).toEqual(["screen-1"]);
    expect(payload.assets).toEqual({});
  });

  it("rejects an archive without the exact document entry", async () => {
    const archive = zipSync({ "nested/figma-export.json": strToU8("{}") });

    await expect(parseFigmaExportArchive(archive)).rejects.toMatchObject({
      code: "MISSING_DOCUMENT",
    });
  });

  it("rejects files that are not declared by the export contract", async () => {
    const archive = zipSync({
      "figma-export.json": strToU8(JSON.stringify(exportFixture())),
      "unexpected.txt": strToU8("not part of the export contract"),
    });

    await expect(parseFigmaExportArchive(archive)).rejects.toMatchObject({
      code: "UNEXPECTED_ENTRY",
    });
  });

  it("rejects high compression-ratio entries before inflating them", async () => {
    const hash = "a".repeat(64);
    const archive = zipSync({
      "figma-export.json": strToU8(JSON.stringify(exportFixture())),
      [`assets/${hash}.png`]: strToU8("x".repeat(200_000)),
    }, { level: 9 });

    await expect(parseFigmaExportArchive(archive)).rejects.toMatchObject({
      code: "ARCHIVE_COMPRESSION_RATIO",
    });
  });

  it("rejects excessive central-directory entry counts", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < FIGMA_IMPORT_ARCHIVE_LIMITS.maxEntries + 1; index += 1) {
      files[`file-${index}.txt`] = new Uint8Array([0]);
    }
    const archive = zipSync(files);

    await expect(parseFigmaExportArchive(archive)).rejects.toMatchObject({
      code: "ARCHIVE_ENTRY_LIMIT",
    });
  });

  it("rejects an oversized entry from central-directory metadata", async () => {
    const archive = zipSync({ "figma-export.json": strToU8(JSON.stringify(exportFixture())) });
    const mutated = archive.slice();
    const view = new DataView(mutated.buffer, mutated.byteOffset, mutated.byteLength);
    let centralOffset = -1;
    for (let offset = 0; offset + 4 <= mutated.byteLength; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        centralOffset = offset;
        break;
      }
    }
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    view.setUint32(centralOffset + 24, FIGMA_IMPORT_ARCHIVE_LIMITS.maxEntryUncompressedBytes + 1, true);

    await expect(parseFigmaExportArchive(mutated)).rejects.toMatchObject({
      code: "ARCHIVE_ENTRY_TOO_LARGE",
    });
  });

  it("revalidates the document and bytes at the main-thread boundary", async () => {
    const payload = {
      document: exportFixture(),
      assets: {},
    };

    await expect(verifyFigmaImportPayload(payload)).resolves.toEqual(payload);
    await expect(verifyFigmaImportPayload({ ...payload, document: { ...payload.document, schemaVersion: 2 } as never }))
      .rejects.toMatchObject({ code: "INVALID_DOCUMENT_CONTRACT" });
  });
});

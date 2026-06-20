import { BadRequestException } from "@nestjs/common";
import { FileChunkSourceType, FileParserType, ParseResultStatus } from "@prisma/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileParserService } from "../src/files/file-parser.service";

describe("FileParserService", () => {
  const service = new FileParserService();
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-workbench-parser-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts text files into chunks", async () => {
    const filePath = path.join(tempDir, "brief.txt");
    await writeFile(filePath, "签到活动需求\n需要连续签到奖励。", "utf8");

    const result = await service.parse({
      fileId: "file-1",
      originalName: "brief.txt",
      extension: "txt",
      mimeType: "text/plain",
      storagePath: filePath,
      extractDir: path.join(tempDir, "extract"),
    });

    expect(result).toMatchObject({
      status: ParseResultStatus.success,
      parserType: FileParserType.plain_text,
      wordCount: expect.any(Number),
    });
    expect(result.extractedText).toContain("连续签到奖励");
    expect(result.chunks?.[0]).toMatchObject({
      sourceType: FileChunkSourceType.text,
      content: expect.stringContaining("签到活动需求"),
    });
  });

  it("marks rp files as partial reference material", async () => {
    const filePath = path.join(tempDir, "prototype.rp");
    await writeFile(filePath, "binary-ish", "utf8");

    const result = await service.parse({
      fileId: "file-rp",
      originalName: "prototype.rp",
      extension: "rp",
      mimeType: "application/octet-stream",
      storagePath: filePath,
      extractDir: path.join(tempDir, "extract-rp"),
    });

    expect(result.status).toBe(ParseResultStatus.partial_success);
    expect(result.parserType).toBe(FileParserType.rp_reference);
    expect(result.summary).toContain("不支持逆向解析");
  });

  it("rejects zip slip paths before extraction", () => {
    expect(() => (service as unknown as { normalizeZipPath: (fileName: string) => string }).normalizeZipPath("../evil.txt"))
      .toThrow(BadRequestException);
  });
});

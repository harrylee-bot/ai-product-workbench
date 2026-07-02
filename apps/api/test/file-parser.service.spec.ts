import { BadRequestException } from "@nestjs/common";
import { FileChunkSourceType, FileParserType, ParseResultStatus } from "@prisma/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("queues rp files for Axure HTML conversion", async () => {
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
    expect(result.parserType).toBe(FileParserType.rp_project);
    expect(result.summary).toContain("转换计划");
    expect(result.prototypeConversion).toMatchObject({
      source: "rp",
      status: "queued",
      expectedOutputKind: "axure_html",
    });
  });

  it("rejects zip slip paths before extraction", () => {
    expect(() => (service as unknown as { normalizeZipPath: (fileName: string) => string }).normalizeZipPath("../evil.txt"))
      .toThrow(BadRequestException);
  });

  it("extracts page text and links from Axure HTML directories", async () => {
    const extractDir = path.join(tempDir, "axure-html");
    await mkdir(path.join(extractDir, "resources"), { recursive: true });
    await mkdir(path.join(extractDir, "files"), { recursive: true });
    await writeFile(path.join(extractDir, "resources", "axure.js"), "/* axure */", "utf8");
    await writeFile(
      path.join(extractDir, "index.html"),
      '<!doctype html><html><head><title>首页</title></head><body><h1>活动首页</h1><a href="files/detail.html">查看明细</a></body></html>',
      "utf8",
    );
    await writeFile(
      path.join(extractDir, "files", "detail.html"),
      '<!doctype html><html><head><title>交易快照</title></head><body><main>交易金额、订单数、渠道来源</main></body></html>',
      "utf8",
    );

    const result = await service.parseAxureHtmlDirectory({
      fileId: "file-html",
      originalName: "交易快照原型",
      mimeType: "text/html",
      extractDir,
    });

    expect(result.status).toBe(ParseResultStatus.success);
    expect(result.parserType).toBe(FileParserType.axure_html_zip);
    expect(result.extractedText).toContain("交易金额");
    expect(result.pages?.[0]).toMatchObject({
      title: "首页",
      outboundLinks: [{ label: "查看明细", targetPath: "files/detail.html" }],
    });
    expect(result.chunks?.some((chunk) => chunk.sourceType === FileChunkSourceType.axure_page)).toBe(true);
  });

  it("filters Axure shell and browser helper pages when prototype pages exist", async () => {
    const extractDir = path.join(tempDir, "axure-html-filtered");
    await mkdir(path.join(extractDir, "resources", "chrome"), { recursive: true });
    await mkdir(path.join(extractDir, "plugins", "sitemap"), { recursive: true });
    await writeFile(path.join(extractDir, "resources", "axure.js"), "/* axure */", "utf8");
    await writeFile(path.join(extractDir, "index.html"), "<html><title>Local Preview</title><body>Local Preview</body></html>", "utf8");
    await writeFile(path.join(extractDir, "start.html"), "<html><title>Start</title><body>Share Prototype</body></html>", "utf8");
    await writeFile(
      path.join(extractDir, "resources", "chrome", "chrome.html"),
      "<html><title>Install Extension</title><body>Axure RP Extension for Chrome</body></html>",
      "utf8",
    );
    await writeFile(
      path.join(extractDir, "活动配置.html"),
      "<html><head><title>活动配置</title></head><body>banner图 背景颜色 分享海报图片</body></html>",
      "utf8",
    );

    const result = await service.parseAxureHtmlDirectory({
      fileId: "file-html-filtered",
      originalName: "活动配置原型",
      mimeType: "text/html",
      extractDir,
    });

    expect(result.status).toBe(ParseResultStatus.success);
    expect(result.pages).toHaveLength(1);
    expect(result.pages?.[0]?.title).toBe("活动配置");
    expect(result.extractedText).toContain("banner图");
    expect(result.extractedText).not.toContain("Axure RP Extension for Chrome");
  });
});

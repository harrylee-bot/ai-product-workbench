import { BadRequestException, Injectable } from "@nestjs/common";
import {
  FileChunkSourceType,
  FileParserType,
  ParseResultStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import yauzl from "yauzl";
import type {
  AxureParseInfo,
  ParsedChunk,
  ParsedImage,
  ParsedPage,
  ParsedSection,
  ParserOutput,
  VisualAttachmentContext,
} from "./file.types";

type ParseInput = {
  fileId: string;
  originalName: string;
  extension: string;
  mimeType: string;
  storagePath: string;
  extractDir: string;
};

type ZipEntryInfo = {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  isDirectory: boolean;
};

const TEXT_CHUNK_SIZE = 2200;
const TEXT_CHUNK_OVERLAP = 180;
const MAX_EXTRACTED_TEXT_LENGTH = 200_000;
const ZIP_MAX_ENTRIES = 800;
const ZIP_MAX_TOTAL_SIZE = 120 * 1024 * 1024;
const ZIP_MAX_ENTRY_SIZE = 30 * 1024 * 1024;

@Injectable()
export class FileParserService {
  async parse(input: ParseInput): Promise<ParserOutput> {
    switch (input.extension) {
      case "txt":
        return this.parsePlainText(input);
      case "md":
        return this.parseMarkdown(input);
      case "docx":
        return this.parseDocx(input);
      case "pdf":
        return this.parsePdf(input);
      case "png":
      case "jpg":
      case "jpeg":
        return this.parseImage(input);
      case "zip":
        return this.parseZip(input);
      case "rp":
        return this.parseRpReference(input);
      default:
        return {
          status: ParseResultStatus.failed,
          parserType: FileParserType.unsupported,
          summary: "暂不支持解析该文件类型。",
          errorMessage: "unsupported_file_type",
        };
    }
  }

  async parsePlainText(input: ParseInput): Promise<ParserOutput> {
    const text = this.cleanText(await readFile(input.storagePath, "utf8"));
    const chunks = this.createTextChunks(text, FileChunkSourceType.text);

    return {
      status: ParseResultStatus.success,
      parserType: FileParserType.plain_text,
      title: input.originalName,
      summary: this.summarizeText(text, "已提取纯文本内容"),
      extractedText: this.limitText(text),
      wordCount: this.countWords(text),
      chunks,
    };
  }

  async parseMarkdown(input: ParseInput): Promise<ParserOutput> {
    const text = this.cleanText(await readFile(input.storagePath, "utf8"));
    const sections = this.parseMarkdownSections(text);
    const chunks = sections.length
      ? sections.flatMap((section, index) =>
          this.createTextChunks(section.content, FileChunkSourceType.section, section.id, index),
        )
      : this.createTextChunks(text, FileChunkSourceType.text);

    return {
      status: ParseResultStatus.success,
      parserType: FileParserType.markdown,
      title: sections[0]?.title ?? input.originalName,
      summary: this.summarizeText(text, `已提取 Markdown 文档，共 ${sections.length || 1} 个段落`),
      extractedText: this.limitText(text),
      wordCount: this.countWords(text),
      sections,
      chunks,
    };
  }

  async parseDocx(input: ParseInput): Promise<ParserOutput> {
    const result = await mammoth.extractRawText({ path: input.storagePath });
    const text = this.cleanText(result.value);
    const warnings = result.messages.map((message) => message.message).filter(Boolean);
    const sections = this.parseLooseSections(text);

    return {
      status: ParseResultStatus.success,
      parserType: FileParserType.docx,
      title: sections[0]?.title ?? input.originalName,
      summary: this.summarizeText(text, `已提取 Word 文档正文，共 ${sections.length || 1} 个文本段落`),
      extractedText: this.limitText(text),
      wordCount: this.countWords(text),
      sections,
      warnings: warnings.length ? warnings : undefined,
      chunks: this.createTextChunks(text, FileChunkSourceType.text),
    };
  }

  async parsePdf(input: ParseInput): Promise<ParserOutput> {
    const { PDFParse } = await import("pdf-parse");
    const buffer = await readFile(input.storagePath);
    const parser = new PDFParse({ data: buffer });
    try {
      const [info, textResult] = await Promise.all([
        parser.getInfo({ parsePageInfo: true }).catch(() => null),
        parser.getText().catch(() => ({ text: "" })),
      ]);
      const text = this.cleanText(textResult.text ?? "");
      const pages = this.buildPdfPages(info?.pages, text);
      const warnings =
        text.length < 80
          ? ["PDF 可提取文本较少，可能是扫描版或图片型 PDF，后续应交给多模态模型理解。"]
          : undefined;
      const visualContexts =
        text.length < 80
          ? [
              this.createVisualContext({
                fileId: input.fileId,
                fileName: input.originalName,
                mimeType: input.mimeType,
                storagePath: input.storagePath,
                purpose: "document_page_image",
                note: "PDF 文本提取不足，模块 4 不做 OCR，后续由多模态模型读取原文件或预览图。",
              }),
            ]
          : undefined;

      return {
        status: ParseResultStatus.success,
        parserType: FileParserType.pdf,
        title: info?.info?.Title || input.originalName,
        summary: this.summarizeText(text, `已尝试提取 PDF 文本，共 ${pages.length || 1} 页`),
        extractedText: text ? this.limitText(text) : undefined,
        wordCount: text ? this.countWords(text) : 0,
        pages,
        visualContexts,
        warnings,
        chunks: text ? this.createTextChunks(text, FileChunkSourceType.pdf_page) : [],
      };
    } finally {
      await parser.destroy();
    }
  }

  async parseImage(input: ParseInput): Promise<ParserOutput> {
    const dimensions = await this.readImageDimensions(input.storagePath, input.extension);
    const image: ParsedImage = {
      id: randomUUID(),
      fileName: input.originalName,
      mimeType: input.mimeType,
      width: dimensions?.width,
      height: dimensions?.height,
      storagePath: input.storagePath,
      description: "图片已保存为视觉上下文，模块 4 不做 OCR 或页面结构识别。",
    };
    const visualContext = this.createVisualContext({
      fileId: input.fileId,
      fileName: input.originalName,
      mimeType: input.mimeType,
      storagePath: input.storagePath,
      width: dimensions?.width,
      height: dimensions?.height,
      purpose: "product_screenshot",
      note: "图片内容后续通过多模态模型理解。",
    });

    return {
      status: ParseResultStatus.success,
      parserType: FileParserType.image,
      title: input.originalName,
      summary: dimensions
        ? `图片已保存，尺寸 ${dimensions.width} x ${dimensions.height}，可作为多模态视觉上下文。`
        : "图片已保存，可作为多模态视觉上下文。",
      images: [image],
      visualContexts: [visualContext],
      chunks: [
        {
          chunkIndex: 0,
          content: image.description ?? "图片视觉上下文",
          tokenEstimate: this.estimateTokens(image.description ?? ""),
          sourceType: FileChunkSourceType.image_context,
          sourceRef: image.id,
        },
      ],
    };
  }

  async parseZip(input: ParseInput): Promise<ParserOutput> {
    const entries = await this.listZipEntries(input.storagePath);
    await this.extractZipSafely(input.storagePath, input.extractDir, entries);

    const axureInfo = this.detectAxureHtmlZip(entries);
    if (axureInfo.isAxureHtmlExport) {
      const pages: ParsedPage[] = axureInfo.pages.slice(0, 50).map((page, index) => ({
        id: randomUUID(),
        title: page.title,
        pageNumber: index + 1,
        filePath: path.join(input.extractDir, page.filePath),
      }));

      return {
        status: ParseResultStatus.partial_success,
        parserType: FileParserType.axure_html_zip,
        title: input.originalName,
        summary: `已识别为 Axure HTML 导出包，入口文件：${axureInfo.entryFile ?? "未识别"}，页面数：${axureInfo.pageCount ?? 0}。一期仅保留预览和页面列表，不还原交互或组件树。`,
        pages,
        axureInfo,
        visualContexts: axureInfo.entryFile
          ? [
              this.createVisualContext({
                fileId: input.fileId,
                fileName: input.originalName,
                mimeType: input.mimeType,
                storagePath: path.join(input.extractDir, axureInfo.entryFile),
                purpose: "axure_page_preview",
                note: "Axure HTML 包仅用于 sandbox iframe 预览和 AI 参考，不执行或逆向还原交互。",
              }),
            ]
          : undefined,
        warnings: ["Axure HTML zip 不做 1:1 交互解析；如需更好理解，请补充关键页面截图。"],
        chunks: pages.map((page, index) => ({
          chunkIndex: index,
          content: `Axure 页面：${page.title ?? page.filePath}`,
          tokenEstimate: 20,
          sourceType: FileChunkSourceType.axure_page,
          sourceRef: page.filePath,
        })),
      };
    }

    const summaryEntries = entries
      .filter((entry) => !entry.isDirectory)
      .slice(0, 40)
      .map((entry) => `${entry.fileName} (${entry.uncompressedSize} bytes)`);
    const content = summaryEntries.join("\n");

    return {
      status: ParseResultStatus.success,
      parserType: FileParserType.zip,
      title: input.originalName,
      summary: `已解析 ZIP 文件结构，共 ${entries.length} 个条目，未识别为 Axure HTML 导出包。`,
      extractedText: content,
      chunks: this.createTextChunks(content, FileChunkSourceType.text),
      warnings: entries.length > summaryEntries.length ? ["ZIP 条目较多，摘要仅展示前 40 个文件。"] : undefined,
    };
  }

  async parseRpReference(input: ParseInput): Promise<ParserOutput> {
    const summary =
      "该文件为 Axure RP 源文件，当前版本仅作为参考资料保存，不支持逆向解析。建议上传 Axure 导出的 HTML zip 或关键页面截图，以便 AI 更好理解原型。";

    return {
      status: ParseResultStatus.partial_success,
      parserType: FileParserType.rp_reference,
      title: input.originalName,
      summary,
      warnings: ["不支持 .rp 源文件逆向解析，也不承诺 .rp 1:1 转 HTML。"],
      chunks: [
        {
          chunkIndex: 0,
          content: summary,
          tokenEstimate: this.estimateTokens(summary),
          sourceType: FileChunkSourceType.text,
        },
      ],
    };
  }

  private parseMarkdownSections(text: string): ParsedSection[] {
    const sections: ParsedSection[] = [];
    const lines = text.split(/\r?\n/);
    let current: ParsedSection | null = null;

    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        if (current) sections.push(current);
        current = {
          id: randomUUID(),
          title: heading[2].trim(),
          level: heading[1].length,
          content: "",
          order: sections.length,
        };
        continue;
      }

      if (!current) {
        current = {
          id: randomUUID(),
          title: "正文",
          level: 1,
          content: "",
          order: 0,
        };
      }
      current.content = `${current.content}${current.content ? "\n" : ""}${line}`.trim();
    }

    if (current) sections.push(current);
    return sections.filter((section) => section.title || section.content);
  }

  private parseLooseSections(text: string): ParsedSection[] {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (!paragraphs.length) return [];

    return paragraphs.slice(0, 80).map((content, index) => {
      const firstLine = content.split(/\r?\n/)[0]?.trim();
      const title = firstLine && firstLine.length <= 60 ? firstLine : index === 0 ? "正文" : undefined;
      return {
        id: randomUUID(),
        title,
        level: title ? 1 : undefined,
        content,
        order: index,
      };
    });
  }

  private buildPdfPages(pages: unknown, text: string): ParsedPage[] {
    if (Array.isArray(pages) && pages.length) {
      return pages.map((page, index) => {
        const maybePage = page as { pageLabel?: string; width?: number; height?: number };
        return {
          id: randomUUID(),
          title: maybePage.pageLabel ? `第 ${maybePage.pageLabel} 页` : `第 ${index + 1} 页`,
          pageNumber: index + 1,
          content: index === 0 ? this.limitText(text, 1000) : undefined,
        };
      });
    }

    return [
      {
        id: randomUUID(),
        title: "第 1 页",
        pageNumber: 1,
        content: this.limitText(text, 1000),
      },
    ];
  }

  private async listZipEntries(filePath: string): Promise<ZipEntryInfo[]> {
    const zipFile = await this.openZip(filePath);
    const entries: ZipEntryInfo[] = [];
    let totalSize = 0;

    try {
      return await new Promise((resolve, reject) => {
        zipFile.readEntry();
        zipFile.on("entry", (entry) => {
          try {
            const fileName = entry.fileName;
            const isDirectory = fileName.endsWith("/");
            const normalized = this.normalizeZipPath(fileName);
            totalSize += entry.uncompressedSize;

            if (entries.length >= ZIP_MAX_ENTRIES) {
              reject(new BadRequestException("ZIP 文件数量超过限制"));
              return;
            }
            if (entry.uncompressedSize > ZIP_MAX_ENTRY_SIZE) {
              reject(new BadRequestException("ZIP 内单个文件超过限制"));
              return;
            }
            if (totalSize > ZIP_MAX_TOTAL_SIZE) {
              reject(new BadRequestException("ZIP 解压后总大小超过限制"));
              return;
            }

            entries.push({
              fileName: normalized,
              compressedSize: entry.compressedSize,
              uncompressedSize: entry.uncompressedSize,
              isDirectory,
            });
            zipFile.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zipFile.once("end", () => resolve(entries));
        zipFile.once("error", reject);
      });
    } finally {
      zipFile.close();
    }
  }

  private async extractZipSafely(filePath: string, destination: string, entries: ZipEntryInfo[]) {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });

    const allowedEntries = new Map(entries.map((entry) => [entry.fileName, entry]));
    const zipFile = await this.openZip(filePath);

    try {
      await new Promise<void>((resolve, reject) => {
        zipFile.readEntry();
        zipFile.on("entry", (entry) => {
          let normalized: string;
          try {
            normalized = this.normalizeZipPath(entry.fileName);
          } catch (error) {
            reject(error);
            return;
          }

          try {
            const entryInfo = allowedEntries.get(normalized);
            if (!entryInfo) {
              reject(new BadRequestException("ZIP 条目校验失败"));
              return;
            }

            const targetPath = path.resolve(destination, normalized);
            const destinationRoot = path.resolve(destination);
            if (!targetPath.startsWith(`${destinationRoot}${path.sep}`) && targetPath !== destinationRoot) {
              reject(new BadRequestException("ZIP 内包含非法路径"));
              return;
            }

            if (entryInfo.isDirectory) {
              mkdir(targetPath, { recursive: true })
                .then(() => zipFile.readEntry())
                .catch(reject);
              return;
            }

            zipFile.openReadStream(entry, async (streamError, readStream) => {
              if (streamError || !readStream) {
                reject(streamError ?? new BadRequestException("ZIP 文件读取失败"));
                return;
              }

              try {
                await mkdir(path.dirname(targetPath), { recursive: true });
                const chunks: Buffer[] = [];
                let total = 0;
                readStream.on("data", (chunk: Buffer) => {
                  total += chunk.length;
                  if (total > ZIP_MAX_ENTRY_SIZE) {
                    readStream.destroy(new BadRequestException("ZIP 内单个文件超过限制"));
                    return;
                  }
                  chunks.push(chunk);
                });
                readStream.once("error", reject);
                readStream.once("end", async () => {
                  try {
                    await writeFile(targetPath, Buffer.concat(chunks));
                    zipFile.readEntry();
                  } catch (error) {
                    reject(error);
                  }
                });
              } catch (error) {
                reject(error);
              }
            });
          } catch (error) {
            reject(error);
          }
        });
        zipFile.once("end", () => resolve());
        zipFile.once("error", reject);
      });
    } finally {
      zipFile.close();
    }
  }

  private openZip(filePath: string) {
    return new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
        if (error || !zipFile) {
          reject(error ?? new BadRequestException("ZIP 文件无法打开"));
          return;
        }
        resolve(zipFile);
      });
    });
  }

  private normalizeZipPath(fileName: string) {
    const normalized = fileName.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0")) {
      throw new BadRequestException("ZIP 内包含非法文件名");
    }

    const parts = normalized.split("/");
    if (parts.some((part) => part === "..")) {
      throw new BadRequestException("ZIP 内包含路径穿越文件");
    }

    return normalized;
  }

  private detectAxureHtmlZip(entries: ZipEntryInfo[]): AxureParseInfo {
    const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.fileName);
    const lowerFiles = files.map((file) => file.toLowerCase());
    const entryFile =
      files.find((file) => file.toLowerCase() === "index.html") ??
      files.find((file) => file.toLowerCase() === "start.html") ??
      files.find((file) => file.toLowerCase().endsWith("/index.html")) ??
      files.find((file) => file.toLowerCase().endsWith("/start.html"));
    const hasAxureHints = lowerFiles.some(
      (file) =>
        file.includes("axure") ||
        file.startsWith("resources/") ||
        file.includes("/resources/") ||
        file.startsWith("data/") ||
        file.includes("/data/") ||
        file.startsWith("files/") ||
        file.includes("/files/"),
    );
    const htmlPages = files.filter((file) => file.toLowerCase().endsWith(".html"));
    const isAxureHtmlExport = Boolean(entryFile && hasAxureHints && htmlPages.length >= 1);

    if (!isAxureHtmlExport) {
      return {
        isAxureHtmlExport: false,
        pages: [],
        assetCount: files.length,
        notes: ["未识别到 Axure HTML 导出包特征。"],
      };
    }

    const pages = htmlPages.slice(0, 200).map((file) => ({
      title: this.titleFromFileName(file),
      filePath: file,
    }));

    return {
      isAxureHtmlExport,
      entryFile,
      pageCount: pages.length,
      pages,
      assetCount: files.length,
      notes: ["仅识别页面列表和入口文件，不执行 zip 内脚本。"],
    };
  }

  private async readImageDimensions(filePath: string, extension: string) {
    const buffer = await readFile(filePath);

    if (extension === "png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }

    if ((extension === "jpg" || extension === "jpeg") && buffer.length >= 4) {
      return this.readJpegDimensions(buffer);
    }

    return undefined;
  }

  private readJpegDimensions(buffer: Buffer) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) return undefined;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
    return undefined;
  }

  private createVisualContext(input: {
    fileId: string;
    fileName: string;
    mimeType: string;
    storagePath: string;
    width?: number;
    height?: number;
    purpose: VisualAttachmentContext["purpose"];
    note?: string;
  }): VisualAttachmentContext {
    return {
      id: randomUUID(),
      fileId: input.fileId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      storagePath: input.storagePath,
      purpose: input.purpose,
      modelInput: {
        type: "image",
        fileRef: input.fileId,
      },
      note: input.note,
    };
  }

  private createTextChunks(
    text: string,
    sourceType: FileChunkSourceType,
    sourceRef?: string,
    indexOffset = 0,
  ): ParsedChunk[] {
    const normalized = this.cleanText(text);
    if (!normalized) return [];

    const chunks: ParsedChunk[] = [];
    let cursor = 0;
    while (cursor < normalized.length) {
      const end = Math.min(cursor + TEXT_CHUNK_SIZE, normalized.length);
      const content = normalized.slice(cursor, end).trim();
      if (content) {
        chunks.push({
          chunkIndex: indexOffset * 1000 + chunks.length,
          content,
          tokenEstimate: this.estimateTokens(content),
          sourceType,
          sourceRef,
        });
      }
      if (end >= normalized.length) break;
      cursor = Math.max(end - TEXT_CHUNK_OVERLAP, cursor + 1);
    }
    return chunks;
  }

  private cleanText(text: string) {
    return text.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  private limitText(text: string, maxLength = MAX_EXTRACTED_TEXT_LENGTH) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}\n\n[内容过长，已截断保存预览文本]`;
  }

  private summarizeText(text: string, prefix: string) {
    const preview = this.limitText(this.cleanText(text), 220).replace(/\n/g, " ");
    return preview ? `${prefix}：${preview}` : prefix;
  }

  private countWords(text: string) {
    const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const latinWords = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
    return chineseChars + latinWords;
  }

  private estimateTokens(text: string) {
    return Math.max(1, Math.ceil(text.length / 3.5));
  }

  private titleFromFileName(fileName: string) {
    const baseName = path.basename(fileName, path.extname(fileName));
    return decodeURIComponent(baseName).replace(/[_-]+/g, " ").trim() || fileName;
  }
}

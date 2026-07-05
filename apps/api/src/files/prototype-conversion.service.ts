import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FileAsset,
  FileAssetStatus,
  FileChunkSourceType,
  FileParserType,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  ParseResultStatus,
  Prisma,
  ConversationStatus,
  PrototypeConversionJob,
  PrototypeConversionStatus,
  UserRole,
} from "@prisma/client";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthenticatedUser } from "../auth/auth.types";
import { toInputJson } from "../ai/ai-vibe.helpers";
import { PrismaService } from "../prisma/prisma.service";
import { FileParserService } from "./file-parser.service";
import type {
  ParsedPage,
  ParserOutput,
  PrototypeConversionPlan,
  VisualAttachmentContext,
} from "./file.types";

type FileWithConversation = FileAsset & {
  conversation: {
    id: string;
    ownerId: string;
    status: ConversationStatus;
    deletedAt: Date | null;
  };
};

type BrowserModule = {
  chromium?: {
    launch: (options?: Record<string, unknown>) => Promise<{
      newPage: (options?: Record<string, unknown>) => Promise<{
        goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
        screenshot: (options: { path: string; fullPage?: boolean }) => Promise<unknown>;
        close: () => Promise<unknown>;
      }>;
      close: () => Promise<unknown>;
    }>;
  };
};

@Injectable()
export class PrototypeConversionService {
  private readonly logger = new Logger(PrototypeConversionService.name);
  private readonly uploadRoot: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FileParserService) private readonly parser: FileParserService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.uploadRoot =
      this.config.get<string>("FILE_UPLOAD_ROOT") ??
      path.resolve(process.cwd(), "storage/uploads");
  }

  async enqueueForFile(file: FileAsset, plan: PrototypeConversionPlan) {
    return this.enqueueForFileWithOptions(file, plan, { autoRun: true });
  }

  async enqueueForFileWithOptions(
    file: FileAsset,
    plan: PrototypeConversionPlan,
    options: { autoRun?: boolean } = {},
  ) {
    if (file.extension !== "rp") return null;
    const job = await this.prisma.prototypeConversionJob.upsert({
      where: { fileAssetId: file.id },
      create: {
        fileAssetId: file.id,
        conversationId: file.conversationId,
        status: PrototypeConversionStatus.queued,
        stage: plan.stage,
        sourceFilePath: plan.sourceFilePath,
        converterName: "axure-rp-html-worker",
        converterVersion: this.config.get<string>("AXURE_RP_CONVERTER_VERSION"),
        metadata: toInputJson(plan),
      },
      update: {
        status: PrototypeConversionStatus.queued,
        stage: plan.stage,
        sourceFilePath: plan.sourceFilePath,
        errorMessage: null,
        completedAt: null,
        converterVersion: this.config.get<string>("AXURE_RP_CONVERTER_VERSION"),
        metadata: toInputJson(plan),
      },
    });

    if ((options.autoRun ?? true) && this.hasConverterCommand() && this.shouldAutoRun()) {
      queueMicrotask(() => {
        void this.runConversionJob(job.id).catch((error) => {
          this.logger.error(`prototype_conversion_failed:${job.id}`, error instanceof Error ? error.stack : String(error));
        });
      });
    }
    return this.toJobItem(job);
  }

  async backfillRpConversions(input: {
    conversationId?: string;
    limit?: number;
    run?: boolean;
    force?: boolean;
    background?: boolean;
  } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
    const run = input.run ?? true;
    const background = input.background ?? true;
    const force = Boolean(input.force);
    const files = await this.prisma.fileAsset.findMany({
      where: {
        extension: "rp",
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(force
          ? {}
          : {
              OR: [
                { prototypeConversionJob: { is: null } },
                { prototypeConversionJob: { status: { not: PrototypeConversionStatus.succeeded } } },
              ],
            }),
      },
      include: { prototypeConversionJob: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    const jobIdsToRun: string[] = [];
    let enqueuedCount = 0;
    let skippedCount = 0;
    const items = [];

    for (const file of files) {
      if (!force && file.prototypeConversionJob?.status === PrototypeConversionStatus.running) {
        skippedCount += 1;
        items.push({
          fileId: file.id,
          fileName: file.originalName,
          skipped: true,
          reason: "conversion_already_running",
          job: this.toJobItem(file.prototypeConversionJob),
        });
        continue;
      }

      if (!force && file.prototypeConversionJob?.status === PrototypeConversionStatus.succeeded) {
        skippedCount += 1;
        items.push({
          fileId: file.id,
          fileName: file.originalName,
          skipped: true,
          reason: "conversion_already_succeeded",
          job: this.toJobItem(file.prototypeConversionJob),
        });
        continue;
      }

      const job = await this.enqueueForFileWithOptions(
        file,
        {
          source: "rp",
          status: "queued",
          stage: "queued",
          sourceFilePath: file.storagePath,
          expectedOutputKind: "axure_html",
          converter: {
            requiredRuntime: "macos_axure_rp",
            commandConfigured: this.hasConverterCommand(),
          },
        },
        { autoRun: false },
      );
      if (job) {
        enqueuedCount += 1;
        jobIdsToRun.push(job.id);
        items.push({
          fileId: file.id,
          fileName: file.originalName,
          skipped: false,
          job,
        });
      }
    }

    let runResult: { attempted: number; completed: number; failed: number } | undefined;
    if (run && jobIdsToRun.length) {
      if (background) {
        this.runJobsInBackground(jobIdsToRun);
      } else {
        runResult = await this.runJobsSequentially(jobIdsToRun);
      }
    }

    return {
      matchedCount: files.length,
      enqueuedCount,
      skippedCount,
      runRequested: run,
      background,
      backgroundStarted: Boolean(run && background && jobIdsToRun.length),
      converterConfigured: this.hasConverterCommand(),
      runResult,
      items,
    };
  }

  async getJobForFile(user: AuthenticatedUser, fileId: string) {
    await this.getAccessibleFile(user, fileId);
    const job = await this.prisma.prototypeConversionJob.findUnique({ where: { fileAssetId: fileId } });
    return { job: job ? this.toJobItem(job) : null };
  }

  async runConversionForFile(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId);
    if (file.extension !== "rp") throw new BadRequestException("PROTOTYPE_CONVERSION_REQUIRES_RP_FILE");
    const existingJob = await this.prisma.prototypeConversionJob.findUnique({
      where: { fileAssetId: file.id },
    });
    if (existingJob?.status === PrototypeConversionStatus.running) {
      return { job: this.toJobItem(existingJob) };
    }

    const job = await this.prisma.prototypeConversionJob.upsert({
      where: { fileAssetId: file.id },
      create: {
        fileAssetId: file.id,
        conversationId: file.conversationId,
        status: PrototypeConversionStatus.queued,
        stage: "queued",
        sourceFilePath: file.storagePath,
        converterName: "axure-rp-html-worker",
        converterVersion: this.config.get<string>("AXURE_RP_CONVERTER_VERSION"),
      },
      update: {
        status: PrototypeConversionStatus.queued,
        stage: "queued",
        errorMessage: null,
        startedAt: null,
        completedAt: null,
      },
    });
    return { job: this.toJobItem(await this.runConversionJob(job.id)) };
  }

  async runConversionJob(jobId: string) {
    const command = this.getConverterCommand();
    if (!command) {
      const job = await this.prisma.prototypeConversionJob.update({
        where: { id: jobId },
        data: {
          status: PrototypeConversionStatus.queued,
          stage: "waiting_for_worker",
          errorMessage: "AXURE_RP_CONVERTER_BIN 未配置，等待 macOS Axure Worker 处理。",
        },
      });
      return job;
    }

    const job = await this.prisma.prototypeConversionJob.findUnique({
      where: { id: jobId },
      include: { fileAsset: { include: { conversation: true } } },
    });
    if (!job || !job.fileAsset || job.fileAsset.deletedAt) {
      throw new NotFoundException("PROTOTYPE_CONVERSION_JOB_NOT_FOUND");
    }
    if (job.fileAsset.extension !== "rp") {
      throw new BadRequestException("PROTOTYPE_CONVERSION_REQUIRES_RP_FILE");
    }

    const runnableStatuses: PrototypeConversionStatus[] = [
      PrototypeConversionStatus.queued,
      PrototypeConversionStatus.failed,
      PrototypeConversionStatus.canceled,
    ];
    if (!runnableStatuses.includes(job.status)) {
      return job;
    }

    const attemptId = randomUUID();
    const outputDir = path.join(this.uploadRoot, job.conversationId, `${job.fileAssetId}_axure_html`, attemptId);
    const lock = await this.prisma.prototypeConversionJob.updateMany({
      where: {
        id: job.id,
        status: { in: [PrototypeConversionStatus.queued, PrototypeConversionStatus.failed, PrototypeConversionStatus.canceled] },
      },
      data: {
        status: PrototypeConversionStatus.running,
        stage: "converting_rp_to_html",
        outputPath: outputDir,
        errorMessage: null,
        startedAt: new Date(),
        completedAt: null,
        metadata: toInputJson({
          ...(asRecord(job.metadata) ?? {}),
          attemptId,
        }),
      },
    });
    if (lock.count === 0) {
      return await this.prisma.prototypeConversionJob.findUnique({ where: { id: job.id } }) ?? job;
    }

    await mkdir(outputDir, { recursive: true });

    try {
      const result = await runConverterCommand({
        bin: command.bin,
        args: command.args.map((arg) =>
          arg.replaceAll("{input}", job.fileAsset.storagePath).replaceAll("{output}", outputDir),
        ),
        timeoutMs: command.timeoutMs,
      });
      const converterMetadata = {
        command: path.basename(command.bin),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };

      await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: {
          stage: "parsing_axure_html",
          metadata: toInputJson({ ...(asRecord(job.metadata) ?? {}), attemptId, converterRun: converterMetadata }),
        },
      });

      const output = await this.parser.parseAxureHtmlDirectory({
        fileId: job.fileAsset.id,
        originalName: job.fileAsset.originalName,
        mimeType: "text/html",
        extractDir: outputDir,
      });
      if (output.status === ParseResultStatus.failed) {
        throw new Error(output.errorMessage ?? output.summary ?? "AXURE_HTML_PARSE_FAILED");
      }

      await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: { stage: "capturing_screenshots" },
      });
      const screenshotContexts = await this.captureScreenshots(job.fileAsset, output.pages ?? [], outputDir);
      if (screenshotContexts.length) {
        output.visualContexts = [...(output.visualContexts ?? []), ...screenshotContexts];
      }

      await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: { stage: "persisting_parse_result" },
      });
      await this.persistParserOutput(job.fileAsset, output);

      await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: { stage: "persisting_visual_knowledge" },
      });
      await this.persistPrototypeKnowledge(job.fileAsset as FileWithConversation, output);

      const updated = await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: {
          status: PrototypeConversionStatus.succeeded,
          stage: "completed",
          outputPath: outputDir,
          outputEntryFile: output.axureInfo?.entryFile,
          pageCount: output.pages?.length ?? 0,
          screenshotCount: screenshotContexts.length,
          completedAt: new Date(),
          errorMessage: null,
        },
      });
      return updated;
    } catch (error) {
      const updated = await this.prisma.prototypeConversionJob.update({
        where: { id: job.id },
        data: {
          status: PrototypeConversionStatus.failed,
          stage: "failed",
          completedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
      await this.prisma.fileAsset.update({
        where: { id: job.fileAsset.id },
        data: {
          status: FileAssetStatus.parse_failed,
          parseError: updated.errorMessage,
        },
      });
      return updated;
    }
  }

  toJobItem(job: PrototypeConversionJob) {
    return {
      id: job.id,
      fileAssetId: job.fileAssetId,
      conversationId: job.conversationId,
      status: job.status,
      stage: job.stage,
      outputPath: job.outputPath ?? undefined,
      outputEntryFile: job.outputEntryFile ?? undefined,
      outputZipPath: job.outputZipPath ?? undefined,
      pageCount: job.pageCount,
      screenshotCount: job.screenshotCount,
      converterName: job.converterName ?? undefined,
      converterVersion: job.converterVersion ?? undefined,
      errorMessage: job.errorMessage ?? undefined,
      metadata: job.metadata ?? undefined,
      startedAt: job.startedAt?.toISOString(),
      completedAt: job.completedAt?.toISOString(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private async captureScreenshots(
    file: FileAsset,
    pages: ParsedPage[],
    outputDir: string,
  ): Promise<VisualAttachmentContext[]> {
    if (!pages.length) return [];
    const browserModule = await importBrowserModule();
    if (!browserModule?.chromium) {
      return [];
    }

    const screenshotDir = path.join(outputDir, "__snapshots__");
    await mkdir(screenshotDir, { recursive: true });
    const browser = await browserModule.chromium.launch({ headless: true });
    const contexts: VisualAttachmentContext[] = [];

    try {
      for (const [index, pageInfo] of pages.slice(0, 40).entries()) {
        if (!pageInfo.filePath) continue;
        const screenshotPath = path.join(
          screenshotDir,
          `${String(index + 1).padStart(3, "0")}-${safeFileName(pageInfo.title || "page")}.png`,
        );
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        try {
          await page.goto(pathToFileUrl(pageInfo.filePath), { waitUntil: "networkidle", timeout: 20_000 });
          await page.screenshot({ path: screenshotPath, fullPage: true });
          const contextId = randomUUID();
          const previewUrl = this.prototypeSnapshotUrl(file.id, contextId);
          pageInfo.previewImagePath = previewUrl;
          pageInfo.visualContextId = contextId;
          contexts.push({
            id: contextId,
            fileId: file.id,
            fileName: `${file.originalName} / ${pageInfo.title ?? `页面 ${index + 1}`}`,
            mimeType: "image/png",
            width: 1440,
            height: 1200,
            storagePath: screenshotPath,
            previewUrl,
            purpose: "prototype_snapshot",
            modelInput: {
              type: "image",
              fileRef: file.id,
            },
            note: "由 Axure HTML 页面自动截图生成，用于需求文档插图和多模态理解。",
          });
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
    return contexts;
  }

  private runJobsInBackground(jobIds: string[]) {
    queueMicrotask(() => {
      void this.runJobsSequentially(jobIds).catch((error) => {
        this.logger.error("prototype_conversion_backfill_failed", error instanceof Error ? error.stack : String(error));
      });
    });
  }

  private async runJobsSequentially(jobIds: string[]) {
    let completed = 0;
    let failed = 0;
    for (const jobId of jobIds) {
      const job = await this.runConversionJob(jobId);
      if (job.status === PrototypeConversionStatus.succeeded || job.status === PrototypeConversionStatus.queued) {
        completed += 1;
      } else {
        failed += 1;
      }
    }
    return {
      attempted: jobIds.length,
      completed,
      failed,
    };
  }

  private async persistParserOutput(file: FileAsset, output: ParserOutput) {
    const status =
      output.parserType === FileParserType.unsupported
        ? FileAssetStatus.unsupported
        : output.status === ParseResultStatus.failed
          ? FileAssetStatus.parse_failed
          : FileAssetStatus.parsed;

    await this.prisma.$transaction(async (tx) => {
      await tx.fileChunk.deleteMany({ where: { fileAssetId: file.id } });
      await tx.fileParseResult.upsert({
        where: { fileAssetId: file.id },
        create: {
          fileAssetId: file.id,
          conversationId: file.conversationId,
          status: output.status,
          parserType: output.parserType,
          title: output.title,
          summary: output.summary,
          extractedText: output.extractedText,
          wordCount: output.wordCount,
          sections: toOptionalJson(output.sections),
          pages: toOptionalJson(output.pages),
          images: toOptionalJson(output.images),
          visualContexts: toOptionalJson(output.visualContexts),
          axureInfo: toOptionalJson(output.axureInfo),
          errorMessage: output.errorMessage,
          warnings: toOptionalJson(output.warnings),
        },
        update: {
          status: output.status,
          parserType: output.parserType,
          title: output.title,
          summary: output.summary,
          extractedText: output.extractedText,
          wordCount: output.wordCount,
          sections: toOptionalJson(output.sections),
          pages: toOptionalJson(output.pages),
          images: toOptionalJson(output.images),
          visualContexts: toOptionalJson(output.visualContexts),
          axureInfo: toOptionalJson(output.axureInfo),
          errorMessage: output.errorMessage,
          warnings: toOptionalJson(output.warnings),
        },
      });

      if (output.chunks?.length) {
        await tx.fileChunk.createMany({
          data: output.chunks.map((chunk, index) => ({
            fileAssetId: file.id,
            conversationId: file.conversationId,
            chunkIndex: index,
            content: chunk.content,
            tokenEstimate: chunk.tokenEstimate,
            sourceType: chunk.sourceType,
            sourceRef: chunk.sourceRef,
          })),
        });
      }
      await tx.fileAsset.update({
        where: { id: file.id },
        data: {
          status,
          parseError: output.errorMessage,
        },
      });
    });
  }

  private async persistPrototypeKnowledge(file: FileWithConversation, output: ParserOutput) {
    const pages = output.pages ?? [];
    const sourceTypes = [
      KnowledgeType.prototype_package,
      KnowledgeType.prototype_page,
      KnowledgeType.prototype_snapshot,
      KnowledgeType.prototype_flow_edge,
    ];

    await this.prisma.$transaction(async (tx) => {
      await tx.knowledgeItem.deleteMany({
        where: {
          sourceFileId: file.id,
          source: KnowledgeSource.file_extraction,
          type: { in: sourceTypes },
        },
      });

      const created = [];
      created.push(await tx.knowledgeItem.create({
        data: {
          title: `原型项目：${file.originalName}`,
          content: [
            `来源文件：${file.originalName}`,
            `入口文件：${output.axureInfo?.entryFile ?? "未识别"}`,
            `页面数量：${pages.length}`,
            "页面清单：",
            ...pages.map((page, index) => `${index + 1}. ${page.title ?? page.filePath ?? "未命名页面"}`),
          ].join("\n"),
          summary: output.summary,
          type: KnowledgeType.prototype_package,
          status: KnowledgeStatus.active,
          scope: "conversation",
          tags: toInputJson(["rp", "axure", "prototype_package", file.originalName]),
          priority: "high",
          source: KnowledgeSource.file_extraction,
          sourceConversationId: file.conversationId,
          sourceFileId: file.id,
          createdBy: file.uploadedBy,
          updatedBy: file.uploadedBy,
        },
      }));

      for (const page of pages) {
        created.push(await tx.knowledgeItem.create({
          data: {
            title: `原型页面：${page.title ?? path.basename(page.filePath ?? "未命名页面")}`,
            content: buildPageKnowledgeContent(page),
            summary: page.content?.slice(0, 240),
            type: KnowledgeType.prototype_page,
            status: KnowledgeStatus.active,
            scope: "conversation",
            tags: toInputJson(["rp", "axure", "prototype_page", page.title ?? "page"]),
            priority: "high",
            source: KnowledgeSource.file_extraction,
            sourceConversationId: file.conversationId,
            sourceFileId: file.id,
            createdBy: file.uploadedBy,
            updatedBy: file.uploadedBy,
          },
        }));

        if (page.previewImagePath) {
          created.push(await tx.knowledgeItem.create({
            data: {
              title: `原型截图：${page.title ?? path.basename(page.filePath ?? "未命名页面")}`,
              content: [
                `页面：${page.title ?? "未命名页面"}`,
                `截图路径：${page.previewImagePath}`,
                page.content ? `页面文本摘要：${page.content.slice(0, 1000)}` : undefined,
              ].filter(Boolean).join("\n"),
              summary: `Axure HTML 页面截图：${page.title ?? "未命名页面"}`,
              type: KnowledgeType.prototype_snapshot,
              status: KnowledgeStatus.active,
              scope: "conversation",
              tags: toInputJson(["rp", "axure", "prototype_snapshot", page.title ?? "snapshot"]),
              priority: "high",
              source: KnowledgeSource.file_extraction,
              sourceConversationId: file.conversationId,
              sourceFileId: file.id,
              createdBy: file.uploadedBy,
              updatedBy: file.uploadedBy,
            },
          }));
        }

        for (const link of page.outboundLinks ?? []) {
          created.push(await tx.knowledgeItem.create({
            data: {
              title: `原型跳转：${page.title ?? "未命名页面"} -> ${link.label || link.targetPath}`,
              content: [
                `起始页面：${page.title ?? page.filePath ?? "未命名页面"}`,
                `触发文案：${link.label ?? "未命名链接"}`,
                `目标页面文件：${link.targetPath}`,
              ].join("\n"),
              summary: `${page.title ?? "页面"} 跳转到 ${link.label || link.targetPath}`,
              type: KnowledgeType.prototype_flow_edge,
              status: KnowledgeStatus.active,
              scope: "conversation",
              tags: toInputJson(["rp", "axure", "prototype_flow_edge"]),
              priority: "medium",
              source: KnowledgeSource.file_extraction,
              sourceConversationId: file.conversationId,
              sourceFileId: file.id,
              createdBy: file.uploadedBy,
              updatedBy: file.uploadedBy,
            },
          }));
        }
      }

      for (const item of created) {
        await tx.knowledgeVersion.create({
          data: {
            knowledgeItemId: item.id,
            version: 1,
            snapshot: toInputJson({
              id: item.id,
              title: item.title,
              content: item.content,
              summary: item.summary,
              type: item.type,
              status: item.status,
              scope: item.scope,
              tags: item.tags,
              priority: item.priority,
              source: item.source,
              sourceConversationId: item.sourceConversationId,
              sourceFileId: item.sourceFileId,
            }),
            changeSummary: "由 .rp/Axure HTML 原型转换链路自动入库",
            createdBy: file.uploadedBy,
          },
        });
      }
    });
  }

  private async getAccessibleFile(user: AuthenticatedUser, fileId: string): Promise<FileWithConversation> {
    const file = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      include: { conversation: true },
    });
    if (
      !file ||
      file.deletedAt ||
      file.status === FileAssetStatus.deleted ||
      file.conversation.status === ConversationStatus.deleted ||
      file.conversation.deletedAt
    ) {
      throw new NotFoundException("文件不存在");
    }
    if (user.role !== UserRole.admin && file.conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该文件");
    }
    return file as FileWithConversation;
  }

  private hasConverterCommand() {
    return Boolean(this.config.get<string>("AXURE_RP_CONVERTER_BIN")?.trim());
  }

  private shouldAutoRun() {
    return this.config.get<string>("AXURE_RP_AUTO_RUN") !== "false";
  }

  private getConverterCommand() {
    const bin = this.config.get<string>("AXURE_RP_CONVERTER_BIN")?.trim();
    if (!bin) return null;
    return {
      bin,
      args: parseConverterArgs(this.config.get<string>("AXURE_RP_CONVERTER_ARGS")),
      timeoutMs: parsePositiveInteger(this.config.get<string>("AXURE_RP_CONVERTER_TIMEOUT_MS"), 180_000),
    };
  }

  private prototypeSnapshotUrl(fileId: string, contextId: string) {
    const configured = this.config.get<string>("NEXT_PUBLIC_API_BASE_URL") ??
      this.config.get<string>("API_PUBLIC_BASE_URL");
    const apiBase = (configured?.trim() || "http://localhost:4000/api").replace(/\/$/, "");
    return `${apiBase}/files/${encodeURIComponent(fileId)}/visual-contexts/${encodeURIComponent(contextId)}`;
  }
}

function parseConverterArgs(raw?: string) {
  if (!raw?.trim()) return ["{input}", "{output}"];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to a minimal whitespace split for simple local scripts.
  }
  return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInteger(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function runConverterCommand(input: { bin: string; args: string[]; timeoutMs: number }) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(input.bin, input.args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const next = `${target === "stdout" ? stdout : stderr}${chunk.toString("utf8")}`.slice(-8000);
      if (target === "stdout") stdout = next;
      else stderr = next;
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`AXURE_RP_CONVERTER_TIMEOUT:${input.timeoutMs}`));
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ exitCode: code, stdout, stderr });
      } else {
        reject(new Error(`AXURE_RP_CONVERTER_FAILED:${code ?? "unknown"} ${stderr || stdout}`.trim()));
      }
    });
  });
}

async function importBrowserModule(): Promise<BrowserModule | null> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<BrowserModule>;
  try {
    return await dynamicImport("playwright");
  } catch {
    try {
      return await dynamicImport("@playwright/test");
    } catch {
      return null;
    }
  }
}

function pathToFileUrl(filePath: string) {
  const normalized = path.resolve(filePath).replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`;
}

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return (normalized || "page").slice(0, 80);
}

function buildPageKnowledgeContent(page: ParsedPage) {
  const links = page.outboundLinks?.length
    ? page.outboundLinks.map((link) => `- ${link.label || "未命名链接"} -> ${link.targetPath}`).join("\n")
    : "无显式 a[href] 页面跳转。";
  return [
    `页面标题：${page.title ?? "未命名页面"}`,
    page.filePath ? `页面文件：${page.filePath}` : undefined,
    page.previewImagePath ? `页面截图：${page.previewImagePath}` : undefined,
    page.content ? `页面文本：\n${page.content}` : "页面文本：未抽取到可见文本。",
    `页面跳转：\n${links}`,
  ].filter(Boolean).join("\n\n");
}

function toOptionalJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return toInputJson(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

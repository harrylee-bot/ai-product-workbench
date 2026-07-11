import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FileAsset,
  FileAssetStatus,
  FileChunkSourceType,
  FileParserType,
  FileStorageProvider,
  KnowledgeSource,
  KnowledgeStatus,
  ParseResultStatus,
  Prisma,
  PrototypeConversionStatus,
  ConversationStatus,
  UserRole,
} from "@prisma/client";
import { fileTypeFromFile } from "file-type";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthenticatedUser } from "../auth/auth.types";
import { assertConversationId } from "../modules/conversation/conversation-id";
import { PrismaService } from "../prisma/prisma.service";
import type { ListConversationFilesQueryDto, UploadFilesDto } from "./dto";
import { FileParserService } from "./file-parser.service";
import type { AttachmentSummary, ParserOutput, RuntimeAttachmentFile, VisualAttachmentContext } from "./file.types";
import { PrototypeConversionService } from "./prototype-conversion.service";
import { assertStoragePath, resolveExistingStorageFile, resolveStoragePath } from "./storage-path";

const ALLOWED_EXTENSIONS = new Set(["txt", "md", "docx", "pdf", "png", "jpg", "jpeg", "zip", "rp"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const ZIP_CONTAINER_EXTENSIONS = new Set(["docx", "zip", "rp"]);
const TEXT_EXTENSIONS = new Set(["txt", "md"]);
const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const DEFAULT_CHAT_ATTACHMENT_MAX_FILES = 8;
const DEFAULT_CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

@Injectable()
export class FileAssetService {
  private readonly uploadRoot: string;
  private readonly chatAttachmentMaxFiles: number;
  private readonly chatAttachmentMaxTotalBytes: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FileParserService) private readonly parser: FileParserService,
    @Inject(ConfigService) configService: ConfigService,
    @Optional() private readonly prototypeConversion?: PrototypeConversionService,
  ) {
    this.uploadRoot = path.resolve(
      configService.get<string>("FILE_UPLOAD_ROOT") ??
      path.resolve(process.cwd(), "storage/uploads"),
    );
    this.chatAttachmentMaxFiles = readPositiveInteger(
      configService.get<string>("CHAT_ATTACHMENT_MAX_FILES"),
      DEFAULT_CHAT_ATTACHMENT_MAX_FILES,
    );
    this.chatAttachmentMaxTotalBytes = readPositiveInteger(
      configService.get<string>("CHAT_ATTACHMENT_MAX_TOTAL_BYTES"),
      DEFAULT_CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    );
  }

  async uploadConversationFiles(
    user: AuthenticatedUser,
    conversationId: string,
    dto: UploadFilesDto,
    files: Express.Multer.File[] = [],
  ) {
    if (!files.length) throw new BadRequestException("请选择要上传的文件");
    const prepared: Array<{ file: Express.Multer.File; extension: string }> = [];
    const items: FileAsset[] = [];

    try {
      if (files.length > MAX_FILES_PER_UPLOAD) throw new BadRequestException("单次最多上传 10 个文件");
      assertConversationId(conversationId);
      await this.getAccessibleConversation(user, conversationId, { requireOwner: true });

      if (dto.conversationId && dto.conversationId !== conversationId) {
        throw new BadRequestException("文件上传会话不一致");
      }
      if (dto.messageId) {
        await this.assertMessageBelongsToConversation(dto.messageId, conversationId);
      }

      for (const file of files) {
        const extension = this.normalizeExtension(file.originalname);
        await this.assertFileAllowed(file, extension);
        prepared.push({ file, extension });
      }

      for (const item of prepared) {
        const created = await this.createFileAsset(user, conversationId, dto, item.file, item.extension);
        items.push(created);
      }
    } catch (error) {
      await this.cleanupFailedUpload(items, files);
      throw error;
    }

    for (const item of items) {
      void this.parseFileInBackground(item.id);
    }

    return { items: items.map((item) => this.toFileAssetItem(item)) };
  }

  async listConversationFiles(user: AuthenticatedUser, conversationId: string, query: ListConversationFilesQueryDto) {
    assertConversationId(conversationId);
    await this.getAccessibleConversation(user, conversationId, { allowArchived: true });
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);

    const where: Prisma.FileAssetWhereInput = {
      conversationId,
      deletedAt: null,
      status: query.status ?? { not: FileAssetStatus.deleted },
    };

    const extension = query.fileType?.trim().toLowerCase().replace(/^\./, "");
    if (extension) where.extension = extension;

    const [files, total] = await this.prisma.$transaction([
      this.prisma.fileAsset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.fileAsset.count({ where }),
    ]);

    return {
      items: files.map((file) => this.toFileAssetItem(file)),
      total,
      page,
      pageSize,
    };
  }

  async getFile(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });
    const parseResult = await this.prisma.fileParseResult.findUnique({
      where: { fileAssetId: file.id },
    });
    const prototypeConversionJob = await this.prisma.prototypeConversionJob.findUnique({
      where: { fileAssetId: file.id },
    });

    return {
      file: this.toFileAssetItem(file),
      parseResult: parseResult ? this.toParseResultItem(parseResult) : undefined,
      prototypeConversionJob: prototypeConversionJob
        ? this.prototypeConversion?.toJobItem(prototypeConversionJob)
        : undefined,
    };
  }

  async getParseResult(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });
    const [parseResult, prototypeConversionJob, chunks] = await Promise.all([
      this.prisma.fileParseResult.findUnique({ where: { fileAssetId: file.id } }),
      this.prisma.prototypeConversionJob.findUnique({ where: { fileAssetId: file.id } }),
      this.prisma.fileChunk.findMany({
        where: { fileAssetId: file.id },
        orderBy: { chunkIndex: "asc" },
      }),
    ]);

    return {
      parseResult: parseResult ? this.toParseResultItem(parseResult) : null,
      prototypeConversionJob: prototypeConversionJob
        ? this.prototypeConversion?.toJobItem(prototypeConversionJob)
        : null,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        fileAssetId: chunk.fileAssetId,
        conversationId: chunk.conversationId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenEstimate: chunk.tokenEstimate ?? undefined,
        sourceType: chunk.sourceType,
        sourceRef: chunk.sourceRef ?? undefined,
        createdAt: chunk.createdAt.toISOString(),
      })),
    };
  }

  async reparseFile(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false, requireOwner: true });
    if (file.status === FileAssetStatus.parsing) {
      throw new ConflictException("文件正在解析，请稍后再试");
    }

    const claimed = await this.prisma.fileAsset.updateMany({
      where: {
        id: file.id,
        deletedAt: null,
        status: { notIn: [FileAssetStatus.deleted, FileAssetStatus.parsing] },
      },
      data: {
        status: FileAssetStatus.uploaded,
        parseError: null,
      },
    });
    if (claimed.count !== 1) throw new ConflictException("文件正在解析或已删除，请刷新后再试");
    const updated = await this.prisma.fileAsset.findUnique({ where: { id: file.id } });
    if (!updated || updated.deletedAt || updated.status === FileAssetStatus.deleted) {
      throw new NotFoundException("文件不存在");
    }
    void this.parseFileInBackground(file.id);

    return this.toFileAssetItem(updated);
  }

  async deleteFile(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false, requireOwner: true });

    await this.prisma.$transaction(async (tx) => {
      const deleted = await tx.fileAsset.updateMany({
        where: {
          id: file.id,
          deletedAt: null,
          status: { notIn: [FileAssetStatus.deleted, FileAssetStatus.parsing] },
        },
        data: {
          status: FileAssetStatus.deleted,
          deletedAt: new Date(),
        },
      });
      if (deleted.count !== 1) {
        throw new ConflictException("文件正在解析或已删除，暂不能清理");
      }
      const conversionJob = await tx.prototypeConversionJob.findUnique({
        where: { fileAssetId: file.id },
      });
      if (conversionJob) {
        const canceled = await tx.prototypeConversionJob.updateMany({
          where: {
            id: conversionJob.id,
            status: { not: PrototypeConversionStatus.running },
          },
          data: {
            status: PrototypeConversionStatus.canceled,
            stage: "source_file_deleted",
            completedAt: new Date(),
          },
        });
        if (canceled.count !== 1) {
          throw new ConflictException("原型转换进行中，暂不能删除该文件");
        }
      }
      await tx.knowledgeItem.updateMany({
        where: {
          sourceFileId: file.id,
          source: KnowledgeSource.file_extraction,
          status: { in: [KnowledgeStatus.active, KnowledgeStatus.draft] },
        },
        data: {
          status: KnowledgeStatus.disabled,
          updatedBy: user.id,
        },
      });
    });

    const storageCleanupPending = !(await this.purgeFileStorage(file));
    return { success: true, storageCleanupPending };
  }

  async attachFilesToMessage(fileIds: string[], messageId: string, conversationId: string) {
    if (!fileIds.length) return;
    await this.prisma.fileAsset.updateMany({
      where: {
        id: { in: fileIds },
        conversationId,
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      data: {
        messageId,
      },
    });
  }

  async getAttachmentSummaries(fileIds: string[], conversationId?: string): Promise<AttachmentSummary[]> {
    if (!fileIds.length) return [];

    const files = await this.prisma.fileAsset.findMany({
      where: {
        id: { in: fileIds },
        ...(conversationId ? { conversationId } : {}),
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      include: { parseResult: true, prototypeConversionJob: true },
    });
    const uniqueIds = [...new Set(fileIds)];
    if (files.length !== uniqueIds.length) {
      throw new BadRequestException("附件不存在或不属于当前会话");
    }
    const order = new Map(fileIds.map((id, index) => [id, index]));

    return files
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      .map((file) => {
        const parseResult = file.parseResult;
        const sections = this.readJsonArray<{ title?: string; content: string }>(parseResult?.sections)
          .slice(0, 5)
          .map((section) => ({
            title: section.title,
            contentPreview: this.preview(section.content, 300),
          }));

        return {
          fileId: file.id,
          fileName: file.originalName,
          fileType: file.extension,
          size: file.size,
          parseStatus: file.status,
          parserType: parseResult?.parserType,
          summary: parseResult?.summary ?? undefined,
          extractedTextPreview: parseResult?.extractedText
            ? this.preview(parseResult.extractedText, 1200)
            : undefined,
          sections: sections.length ? sections : undefined,
          visualContexts: this.readJsonArray(parseResult?.visualContexts),
          axureInfo: this.readJsonValue(parseResult?.axureInfo),
          prototypeConversionJob: file.prototypeConversionJob && this.prototypeConversion
            ? this.prototypeConversion.toJobItem(file.prototypeConversionJob)
            : undefined,
          warnings: this.readJsonArray<string>(parseResult?.warnings),
        };
      });
  }

  async getRuntimeAttachmentFiles(fileIds: string[], conversationId: string): Promise<RuntimeAttachmentFile[]> {
    if (!fileIds.length) return [];
    assertConversationId(conversationId);
    const uniqueIds = [...new Set(fileIds)];
    if (uniqueIds.length > this.chatAttachmentMaxFiles) {
      throw new BadRequestException(`单次对话最多引用 ${this.chatAttachmentMaxFiles} 个附件`);
    }

    const files = await this.prisma.fileAsset.findMany({
      where: {
        id: { in: uniqueIds },
        conversationId,
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
    });
    if (files.length !== uniqueIds.length) {
      throw new BadRequestException("附件不存在或不属于当前会话");
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > this.chatAttachmentMaxTotalBytes) {
      throw new BadRequestException(
        `单次对话附件总大小不能超过 ${formatMegabytes(this.chatAttachmentMaxTotalBytes)}MB`,
      );
    }
    const storageFiles = new Map<string, { path: string; size: number }>();
    await Promise.all(files.map(async (file) => {
      try {
        storageFiles.set(file.id, await resolveExistingStorageFile(this.uploadRoot, file.storagePath));
      } catch {
        throw new BadRequestException(`附件文件不存在：${file.originalName}`);
      }
    }));
    const actualTotalBytes = [...storageFiles.values()].reduce((sum, file) => sum + file.size, 0);
    if (actualTotalBytes > this.chatAttachmentMaxTotalBytes) {
      throw new BadRequestException(
        `单次对话附件总大小不能超过 ${formatMegabytes(this.chatAttachmentMaxTotalBytes)}MB`,
      );
    }
    const order = new Map(fileIds.map((id, index) => [id, index]));

    return files
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0))
      .map((file) => ({
        fileId: file.id,
        fileName: file.originalName,
        fileType: file.extension,
        mimeType: file.mimeType,
        size: storageFiles.get(file.id)!.size,
        storagePath: storageFiles.get(file.id)!.path,
      }));
  }

  async getVisualContextFile(user: AuthenticatedUser, fileId: string, contextId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });
    const parseResult = await this.prisma.fileParseResult.findUnique({
      where: { fileAssetId: file.id },
    });
    const context = this.readJsonArray<VisualAttachmentContext>(parseResult?.visualContexts)
      .find((item) => item.id === contextId);
    if (!context?.storagePath) throw new NotFoundException("视觉素材不存在");

    let filePath: string;

    try {
      filePath = (await resolveExistingStorageFile(this.uploadRoot, context.storagePath)).path;
    } catch {
      throw new NotFoundException("视觉素材文件不存在");
    }
    return {
      filePath,
      mimeType: context.mimeType || "application/octet-stream",
      fileName: path.basename(filePath),
    };
  }

  async parseFileNow(fileId: string) {
    const file = await this.prisma.fileAsset.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt || file.status === FileAssetStatus.deleted) return null;
    assertStoragePath(this.uploadRoot, file.storagePath);
    const claimed = await this.prisma.fileAsset.updateMany({
      where: {
        id: file.id,
        deletedAt: null,
        status: FileAssetStatus.uploaded,
      },
      data: {
        status: FileAssetStatus.parsing,
        parseError: null,
      },
    });
    if (claimed.count !== 1) return null;

    const output = await this.runParser(file);
    return this.saveParserOutput(file, output);
  }

  async failInterruptedParsingFiles() {
    return this.prisma.fileAsset.updateMany({
      where: {
        status: FileAssetStatus.parsing,
        deletedAt: null,
      },
      data: {
        status: FileAssetStatus.parse_failed,
        parseError: "文件解析因服务重启中断，请重新解析。",
      },
    });
  }

  private async createFileAsset(
    user: AuthenticatedUser,
    conversationId: string,
    dto: UploadFilesDto,
    file: Express.Multer.File,
    extension: string,
  ) {
    const projectDir = resolveStoragePath(this.uploadRoot, conversationId);
    const storedName = `${randomUUID()}.${extension}`;
    const storagePath = resolveStoragePath(this.uploadRoot, conversationId, storedName);
    await mkdir(projectDir, { recursive: true });
    await rename(file.path, storagePath);

    try {
      return await this.prisma.fileAsset.create({
        data: {
          conversationId,
          messageId: dto.messageId,
          uploadedBy: user.id,
          originalName: file.originalname,
          storedName,
          mimeType: file.mimetype || this.mimeFromExtension(extension),
          extension,
          size: file.size,
          storageProvider: FileStorageProvider.local,
          storagePath,
          status: FileAssetStatus.uploaded,
        },
      });
    } catch (error) {
      await rm(storagePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async cleanupFailedUpload(created: FileAsset[], files: Express.Multer.File[]) {
    await Promise.all(files.map((file) => rm(file.path, { force: true }).catch(() => undefined)));
    await Promise.all(created.map((file) =>
      rm(assertStoragePath(this.uploadRoot, file.storagePath), { force: true }).catch(() => undefined),
    ));
    if (created.length) {
      await this.prisma.fileAsset.deleteMany({
        where: { id: { in: created.map((file) => file.id) } },
      });
    }
  }

  private async purgeFileStorage(file: FileAsset) {
    let targets: string[];
    try {
      targets = [
        assertStoragePath(this.uploadRoot, file.storagePath),
        resolveStoragePath(this.uploadRoot, file.conversationId, `${file.id}_extracted`),
        resolveStoragePath(this.uploadRoot, file.conversationId, `${file.id}_axure_html`),
      ];
    } catch (error) {
      console.error(`file_storage_cleanup_rejected:${file.id}`, error);
      return false;
    }

    const results = await Promise.allSettled(
      targets.map((target) => rm(target, { force: true, recursive: true })),
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) {
      console.error(`file_storage_cleanup_failed:${file.id}`, failed);
      return false;
    }
    return true;
  }

  private parseFileInBackground(fileId: string) {
    queueMicrotask(() => {
      void this.parseFileNow(fileId).catch((error) => {
        // Background parser failures are persisted for the UI; the request has already completed.
        console.error(`file_parse_failed:${fileId}`, error);
      });
    });
  }

  private async runParser(file: FileAsset): Promise<ParserOutput> {
    try {
      return await this.parser.parse({
        fileId: file.id,
        originalName: file.originalName,
        extension: file.extension,
        mimeType: file.mimeType,
        storagePath: assertStoragePath(this.uploadRoot, file.storagePath),
        extractDir: resolveStoragePath(this.uploadRoot, file.conversationId, `${file.id}_extracted`),
      });
    } catch (error) {
      return {
        status: ParseResultStatus.failed,
        parserType: FileParserType.unsupported,
        summary: "文件解析失败。",
        errorMessage: error instanceof Error ? error.message : "文件解析失败",
        warnings: ["解析失败后可重新解析。"],
        chunks: [],
      };
    }
  }

  private async saveParserOutput(file: FileAsset, output: ParserOutput) {
    const status =
      output.parserType === FileParserType.unsupported
        ? FileAssetStatus.unsupported
        : output.status === ParseResultStatus.failed
          ? FileAssetStatus.parse_failed
          : FileAssetStatus.parsed;

    const parseResult = await this.prisma.$transaction(async (tx) => {
      await tx.fileChunk.deleteMany({ where: { fileAssetId: file.id } });

      const saved = await tx.fileParseResult.upsert({
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
          sections: this.toJson(output.sections),
          pages: this.toJson(output.pages),
          images: this.toJson(output.images),
          visualContexts: this.toJson(output.visualContexts),
          axureInfo: this.toJson(output.axureInfo),
          errorMessage: output.errorMessage,
          warnings: this.toJson(output.warnings),
        },
        update: {
          status: output.status,
          parserType: output.parserType,
          title: output.title,
          summary: output.summary,
          extractedText: output.extractedText,
          wordCount: output.wordCount,
          sections: this.toJson(output.sections),
          pages: this.toJson(output.pages),
          images: this.toJson(output.images),
          visualContexts: this.toJson(output.visualContexts),
          axureInfo: this.toJson(output.axureInfo),
          errorMessage: output.errorMessage,
          warnings: this.toJson(output.warnings),
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
      } else if (output.summary) {
        await tx.fileChunk.create({
          data: {
            fileAssetId: file.id,
            conversationId: file.conversationId,
            chunkIndex: 0,
            content: output.summary,
            tokenEstimate: Math.ceil(output.summary.length / 3.5),
            sourceType: FileChunkSourceType.text,
          },
        });
      }

      await tx.fileAsset.update({
        where: { id: file.id },
        data: {
          status,
          parseError: output.errorMessage,
        },
      });

      return saved;
    });

    if (output.prototypeConversion) {
      await this.prototypeConversion?.enqueueForFile(file, output.prototypeConversion);
    }

    return parseResult;
  }

  private async getAccessibleConversation(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean; requireOwner?: boolean } = {},
  ) {
    assertConversationId(conversationId);
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.status === ConversationStatus.deleted || conversation.deletedAt) {
      throw new NotFoundException("会话不存在");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("会话已归档，请先恢复后再上传文件");
    }
    if ((options.requireOwner || user.role !== UserRole.admin) && conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该会话");
    }
    return conversation;
  }

  private async getAccessibleFile(
    user: AuthenticatedUser,
    fileId: string,
    options: { includeDeleted?: boolean; requireOwner?: boolean } = {},
  ) {
    const file = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      include: { conversation: true },
    });
    if (
      !file ||
      (!options.includeDeleted && (file.deletedAt || file.status === FileAssetStatus.deleted)) ||
      file.conversation.status === ConversationStatus.deleted ||
      file.conversation.deletedAt
    ) {
      throw new NotFoundException("文件不存在");
    }
    if ((options.requireOwner || user.role !== UserRole.admin) && file.conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该文件");
    }
    return file;
  }

  private async assertMessageBelongsToConversation(messageId: string, conversationId: string) {
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
      },
    });
    if (!message) throw new BadRequestException("消息不属于当前会话");
  }

  private async assertFileAllowed(file: Express.Multer.File, extension: string) {
    try {
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        throw new BadRequestException("暂不支持该文件类型");
      }

      const maxSize = IMAGE_EXTENSIONS.has(extension) ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
      if (file.size > maxSize) {
        throw new BadRequestException(IMAGE_EXTENSIONS.has(extension) ? "图片不能超过 10MB" : "文件不能超过 50MB");
      }

      await this.assertFileMagic(file.path, extension);
    } catch (error) {
      await rm(file.path, { force: true });
      throw error;
    }
  }

  private async assertFileMagic(filePath: string, extension: string) {
    const detected = await fileTypeFromFile(filePath);

    if (TEXT_EXTENSIONS.has(extension)) {
      if (detected) throw new BadRequestException("文件内容与扩展名不匹配");
      await this.assertTextFile(filePath);
      return;
    }

    if (extension === "pdf") {
      if (detected?.mime !== "application/pdf") throw new BadRequestException("文件内容与扩展名不匹配");
      return;
    }

    if (extension === "png") {
      if (detected?.mime !== "image/png") throw new BadRequestException("文件内容与扩展名不匹配");
      return;
    }

    if (extension === "jpg" || extension === "jpeg") {
      if (detected?.mime !== "image/jpeg") throw new BadRequestException("文件内容与扩展名不匹配");
      return;
    }

    if (ZIP_CONTAINER_EXTENSIONS.has(extension)) {
      if (detected?.mime !== "application/zip") throw new BadRequestException("文件内容与扩展名不匹配");
      return;
    }
  }

  private async assertTextFile(filePath: string) {
    const sample = await readFile(filePath, { encoding: "utf8" });
    if (sample.includes("\0")) throw new BadRequestException("文本文件包含非法二进制内容");
  }

  private normalizeExtension(fileName: string) {
    return path.extname(fileName).replace(/^\./, "").toLowerCase();
  }

  private mimeFromExtension(extension: string) {
    const mimeMap: Record<string, string> = {
      txt: "text/plain",
      md: "text/markdown",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      zip: "application/zip",
      rp: "application/octet-stream",
    };
    return mimeMap[extension] ?? "application/octet-stream";
  }

  private toFileAssetItem(file: FileAsset) {
    return {
      id: file.id,
      conversationId: file.conversationId,
      messageId: file.messageId ?? undefined,
      uploadedBy: file.uploadedBy,
      originalName: file.originalName,
      storedName: file.storedName,
      mimeType: file.mimeType,
      extension: file.extension,
      size: file.size,
      storageProvider: file.storageProvider,
      publicUrl: file.publicUrl ?? undefined,
      status: file.status,
      parseError: file.parseError ?? undefined,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      deletedAt: file.deletedAt?.toISOString(),
    };
  }

  private toParseResultItem(parseResult: {
    id: string;
    fileAssetId: string;
    conversationId: string;
    status: ParseResultStatus;
    parserType: FileParserType;
    title: string | null;
    summary: string | null;
    extractedText: string | null;
    wordCount: number | null;
    sections: Prisma.JsonValue | null;
    pages: Prisma.JsonValue | null;
    images: Prisma.JsonValue | null;
    visualContexts: Prisma.JsonValue | null;
    axureInfo: Prisma.JsonValue | null;
    errorMessage: string | null;
    warnings: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: parseResult.id,
      fileAssetId: parseResult.fileAssetId,
      conversationId: parseResult.conversationId,
      status: parseResult.status,
      parserType: parseResult.parserType,
      title: parseResult.title ?? undefined,
      summary: parseResult.summary ?? undefined,
      extractedText: parseResult.extractedText ?? undefined,
      wordCount: parseResult.wordCount ?? undefined,
      sections: this.readJsonValue(parseResult.sections),
      pages: this.readJsonValue(parseResult.pages),
      images: this.readJsonValue(parseResult.images),
      visualContexts: this.readJsonValue(parseResult.visualContexts),
      axureInfo: this.readJsonValue(parseResult.axureInfo),
      errorMessage: parseResult.errorMessage ?? undefined,
      warnings: this.readJsonValue(parseResult.warnings),
      createdAt: parseResult.createdAt.toISOString(),
      updatedAt: parseResult.updatedAt.toISOString(),
    };
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return value as Prisma.InputJsonValue;
  }

  private readJsonArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  private readJsonValue<T>(value: unknown): T | undefined {
    return value === null || value === undefined ? undefined : (value as T);
  }

  private preview(text: string, maxLength: number) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
  }
}

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMegabytes(bytes: number) {
  return Math.ceil(bytes / (1024 * 1024));
}

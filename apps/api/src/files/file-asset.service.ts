import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FileAsset,
  FileAssetStatus,
  FileChunkSourceType,
  FileParserType,
  FileStorageProvider,
  ParseResultStatus,
  Prisma,
  ProjectStatus,
  UserRole,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { ListProjectFilesQueryDto, UploadFilesDto } from "./dto";
import { FileParserService } from "./file-parser.service";
import type { AttachmentSummary, ParserOutput } from "./file.types";

const ALLOWED_EXTENSIONS = new Set(["txt", "md", "docx", "pdf", "png", "jpg", "jpeg", "zip", "rp"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const MAX_FILES_PER_UPLOAD = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

@Injectable()
export class FileAssetService {
  private readonly uploadRoot: string;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FileParserService) private readonly parser: FileParserService,
    @Inject(ConfigService) configService: ConfigService,
  ) {
    this.uploadRoot =
      configService.get<string>("FILE_UPLOAD_ROOT") ??
      path.resolve(process.cwd(), "storage/uploads");
  }

  async uploadProjectFiles(
    user: AuthenticatedUser,
    projectId: string,
    dto: UploadFilesDto,
    files: Express.Multer.File[] = [],
  ) {
    if (!files.length) throw new BadRequestException("请选择要上传的文件");
    if (files.length > MAX_FILES_PER_UPLOAD) throw new BadRequestException("单次最多上传 10 个文件");

    const project = await this.getAccessibleProject(user, projectId);

    if (dto.conversationId) {
      await this.assertConversationBelongsToProject(dto.conversationId, projectId);
    }
    if (dto.messageId) {
      await this.assertMessageBelongsToProject(dto.messageId, projectId);
    }

    const items: FileAsset[] = [];
    for (const file of files) {
      const created = await this.createFileAsset(user, projectId, dto, file);
      items.push(created);
      void this.parseFileInBackground(created.id);
    }

    return { items: items.map((item) => this.toFileAssetItem(item)) };
  }

  async listProjectFiles(user: AuthenticatedUser, projectId: string, query: ListProjectFilesQueryDto) {
    await this.getAccessibleProject(user, projectId, { allowArchived: true });
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);

    const where: Prisma.FileAssetWhereInput = {
      projectId,
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

    return {
      file: this.toFileAssetItem(file),
      parseResult: parseResult ? this.toParseResultItem(parseResult) : undefined,
    };
  }

  async getParseResult(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });
    const [parseResult, chunks] = await Promise.all([
      this.prisma.fileParseResult.findUnique({ where: { fileAssetId: file.id } }),
      this.prisma.fileChunk.findMany({
        where: { fileAssetId: file.id },
        orderBy: { chunkIndex: "asc" },
      }),
    ]);

    return {
      parseResult: parseResult ? this.toParseResultItem(parseResult) : null,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        fileAssetId: chunk.fileAssetId,
        projectId: chunk.projectId,
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
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });

    const updated = await this.prisma.fileAsset.update({
      where: { id: file.id },
      data: {
        status: FileAssetStatus.uploaded,
        parseError: null,
      },
    });
    void this.parseFileInBackground(updated.id);

    return this.toFileAssetItem(updated);
  }

  async deleteFile(user: AuthenticatedUser, fileId: string) {
    const file = await this.getAccessibleFile(user, fileId, { includeDeleted: false });

    await this.prisma.fileAsset.update({
      where: { id: file.id },
      data: {
        status: FileAssetStatus.deleted,
        deletedAt: new Date(),
      },
    });

    return { success: true };
  }

  async attachFilesToMessage(fileIds: string[], messageId: string, projectId: string, conversationId: string) {
    if (!fileIds.length) return;
    await this.prisma.fileAsset.updateMany({
      where: {
        id: { in: fileIds },
        projectId,
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      data: {
        messageId,
        conversationId,
      },
    });
  }

  async getAttachmentSummaries(fileIds: string[], projectId?: string): Promise<AttachmentSummary[]> {
    if (!fileIds.length) return [];

    const files = await this.prisma.fileAsset.findMany({
      where: {
        id: { in: fileIds },
        ...(projectId ? { projectId } : {}),
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      include: { parseResult: true },
    });
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
          warnings: this.readJsonArray<string>(parseResult?.warnings),
        };
      });
  }

  async parseFileNow(fileId: string) {
    const file = await this.prisma.fileAsset.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt || file.status === FileAssetStatus.deleted) return null;

    const output = await this.runParser(file);
    return this.saveParserOutput(file, output);
  }

  private async createFileAsset(
    user: AuthenticatedUser,
    projectId: string,
    dto: UploadFilesDto,
    file: Express.Multer.File,
  ) {
    const extension = this.normalizeExtension(file.originalname);
    this.assertFileAllowed(file, extension);

    const projectDir = path.join(this.uploadRoot, projectId);
    const storedName = `${randomUUID()}.${extension}`;
    const storagePath = path.join(projectDir, storedName);
    await mkdir(projectDir, { recursive: true });
    await rename(file.path, storagePath);

    return this.prisma.fileAsset.create({
      data: {
        projectId,
        conversationId: dto.conversationId,
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
    await this.prisma.fileAsset.update({
      where: { id: file.id },
      data: {
        status: FileAssetStatus.parsing,
        parseError: null,
      },
    });

    try {
      return await this.parser.parse({
        fileId: file.id,
        originalName: file.originalName,
        extension: file.extension,
        mimeType: file.mimeType,
        storagePath: file.storagePath,
        extractDir: path.join(this.uploadRoot, file.projectId, `${file.id}_extracted`),
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
          projectId: file.projectId,
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
            projectId: file.projectId,
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
            projectId: file.projectId,
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
          parseResultId: saved.id,
          parseError: output.errorMessage,
        },
      });

      return saved;
    });

    return parseResult;
  }

  private async getAccessibleProject(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.status === ProjectStatus.deleted || project.deletedAt) {
      throw new NotFoundException("项目不存在");
    }
    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再上传文件");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }
    return project;
  }

  private async getAccessibleFile(
    user: AuthenticatedUser,
    fileId: string,
    options: { includeDeleted?: boolean } = {},
  ) {
    const file = await this.prisma.fileAsset.findUnique({
      where: { id: fileId },
      include: { project: true },
    });
    if (
      !file ||
      (!options.includeDeleted && (file.deletedAt || file.status === FileAssetStatus.deleted)) ||
      file.project.status === ProjectStatus.deleted ||
      file.project.deletedAt
    ) {
      throw new NotFoundException("文件不存在");
    }
    if (user.role !== UserRole.admin && file.project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该文件");
    }
    return file;
  }

  private async assertConversationBelongsToProject(conversationId: string, projectId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        projectId,
        deletedAt: null,
      },
    });
    if (!conversation) throw new BadRequestException("会话不属于当前项目");
  }

  private async assertMessageBelongsToProject(messageId: string, projectId: string) {
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        projectId,
      },
    });
    if (!message) throw new BadRequestException("消息不属于当前项目");
  }

  private assertFileAllowed(file: Express.Multer.File, extension: string) {
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      void rm(file.path, { force: true });
      throw new BadRequestException("暂不支持该文件类型");
    }

    const maxSize = IMAGE_EXTENSIONS.has(extension) ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    if (file.size > maxSize) {
      void rm(file.path, { force: true });
      throw new BadRequestException(IMAGE_EXTENSIONS.has(extension) ? "图片不能超过 10MB" : "文件不能超过 50MB");
    }
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
      projectId: file.projectId,
      conversationId: file.conversationId ?? undefined,
      messageId: file.messageId ?? undefined,
      uploadedBy: file.uploadedBy,
      originalName: file.originalName,
      storedName: file.storedName,
      mimeType: file.mimeType,
      extension: file.extension,
      size: file.size,
      storageProvider: file.storageProvider,
      storagePath: file.storagePath,
      publicUrl: file.publicUrl ?? undefined,
      status: file.status,
      parseResultId: file.parseResultId ?? undefined,
      parseError: file.parseError ?? undefined,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      deletedAt: file.deletedAt?.toISOString(),
    };
  }

  private toParseResultItem(parseResult: {
    id: string;
    fileAssetId: string;
    projectId: string;
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
      projectId: parseResult.projectId,
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

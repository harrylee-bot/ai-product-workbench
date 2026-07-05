import { ForbiddenException } from "@nestjs/common";
import {
  FileAssetStatus,
  FileParserType,
  FileStorageProvider,
  ParseResultStatus,
  ConversationStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileAssetService } from "../src/files/file-asset.service";

describe("FileAssetService", () => {
  const prisma = {
    conversation: {
      findUnique: vi.fn(),
    },
    fileAsset: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    fileParseResult: {
      findUnique: vi.fn(),
    },
    fileChunk: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const parser = {
    parse: vi.fn(),
  };
  const config = {
    get: vi.fn().mockReturnValue(undefined),
  };
  const service = new FileAssetService(prisma as never, parser as never, config as never);
  const user = {
    id: "user-1",
    username: "zhangsan",
    displayName: "张三",
    role: UserRole.user,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects normal users from listing files in projects they do not own", async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-2",
      ownerId: "other-user",
      status: ConversationStatus.draft,
      deletedAt: null,
    });

    await expect(service.listConversationFiles(user, "conversation-2", {})).rejects.toThrow(ForbiddenException);
  });

  it("returns attachment summaries scoped to the current conversation", async () => {
    prisma.fileAsset.findMany.mockResolvedValue([
      {
        id: "file-1",
        conversationId: "conversation-1",
        messageId: null,
        uploadedBy: "user-1",
        originalName: "brief.md",
        storedName: "stored.md",
        mimeType: "text/markdown",
        extension: "md",
        size: 128,
        storageProvider: FileStorageProvider.local,
        storagePath: "/tmp/stored.md",
        publicUrl: null,
        status: FileAssetStatus.parsed,
        parseResultId: "parse-1",
        parseError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        parseResult: {
          id: "parse-1",
          fileAssetId: "file-1",
          conversationId: "conversation-1",
          status: ParseResultStatus.success,
          parserType: FileParserType.markdown,
          title: "brief.md",
          summary: "已提取 Markdown 文档",
          extractedText: "签到活动需求正文",
          wordCount: 8,
          sections: [{ title: "背景", content: "签到活动背景" }],
          pages: null,
          images: null,
          visualContexts: null,
          axureInfo: null,
          errorMessage: null,
          warnings: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        prototypeConversionJob: null,
      },
    ]);

    const result = await service.getAttachmentSummaries(["file-1"], "conversation-1");

    expect(prisma.fileAsset.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["file-1"] },
        conversationId: "conversation-1",
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      include: { parseResult: true, prototypeConversionJob: true },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileId: "file-1",
      fileName: "brief.md",
      parserType: FileParserType.markdown,
      extractedTextPreview: "签到活动需求正文",
    });
  });

  it("returns local runtime attachment files in requested order", async () => {
    prisma.fileAsset.findMany.mockResolvedValue([
      fileRecord({ id: "file-2", originalName: "rules.pdf", extension: "pdf", storagePath: "/tmp/rules.pdf" }),
      fileRecord({ id: "file-1", originalName: "brief.md", extension: "md", storagePath: "/tmp/brief.md" }),
    ]);

    const result = await service.getRuntimeAttachmentFiles(["file-1", "file-2"], "conversation-1");

    expect(prisma.fileAsset.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["file-1", "file-2"] },
        conversationId: "conversation-1",
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
    });
    expect(result).toEqual([
      expect.objectContaining({
        fileId: "file-1",
        fileName: "brief.md",
        fileType: "md",
        storagePath: "/tmp/brief.md",
      }),
      expect.objectContaining({
        fileId: "file-2",
        fileName: "rules.pdf",
        fileType: "pdf",
        storagePath: "/tmp/rules.pdf",
      }),
    ]);
  });

  it("cleans every temp file and avoids partial DB writes when one upload is invalid", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-upload-root-"));
    const tempDir = await mkdtemp(path.join(tmpdir(), "workbench-upload-tmp-"));
    const files = [
      await multerFile(tempDir, "valid-1.md", "第一份资料"),
      await multerFile(tempDir, "bad.md", "bad\0content"),
      await multerFile(tempDir, "valid-2.md", "第二份资料"),
    ];
    const localPrisma = {
      ...prisma,
      conversation: { findUnique: vi.fn().mockResolvedValue(projectRecord()) },
      fileAsset: {
        ...prisma.fileAsset,
        create: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    const localService = new FileAssetService(
      localPrisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "FILE_UPLOAD_ROOT" ? root : undefined) } as never,
    );

    await expect(localService.uploadConversationFiles(user, "conversation-1", {}, files)).rejects.toThrow("文本文件包含非法二进制内容");

    expect(localPrisma.fileAsset.create).not.toHaveBeenCalled();
    expect(localPrisma.fileAsset.deleteMany).not.toHaveBeenCalled();
    await expect(stat(files[0].path)).rejects.toThrow();
    await expect(stat(files[1].path)).rejects.toThrow();
    await expect(stat(files[2].path)).rejects.toThrow();
  });
});

async function multerFile(dir: string, originalname: string, content: string): Promise<Express.Multer.File> {
  const filePath = path.join(dir, originalname);
  await writeFile(filePath, content);
  const fileStat = await stat(filePath);
  return {
    fieldname: "files",
    originalname,
    encoding: "7bit",
    mimetype: "text/markdown",
    size: fileStat.size,
    destination: dir,
    filename: originalname,
    path: filePath,
    buffer: Buffer.from(content),
    stream: undefined as never,
  };
}

function projectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.draft,
    deletedAt: null,
    ...overrides,
  };
}

function fileRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    conversationId: "conversation-1",
    messageId: null,
    uploadedBy: "user-1",
    originalName: "brief.md",
    storedName: "stored.md",
    mimeType: "text/markdown",
    extension: "md",
    size: 128,
    storageProvider: FileStorageProvider.local,
    storagePath: "/tmp/stored.md",
    publicUrl: null,
    status: FileAssetStatus.parsed,
    parseResultId: "parse-1",
    parseError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

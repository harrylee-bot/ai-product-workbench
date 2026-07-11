import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import {
  FileAssetStatus,
  FileParserType,
  FileStorageProvider,
  ParseResultStatus,
  KnowledgeSource,
  KnowledgeStatus,
  PrototypeConversionStatus,
  ConversationStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
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
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    prototypeConversionJob: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    knowledgeItem: {
      updateMany: vi.fn(),
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
    prisma.fileAsset.updateMany.mockResolvedValue({ count: 1 });
    prisma.prototypeConversionJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.knowledgeItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => unknown) => callback(prisma));
  });

  it("rejects normal users from listing files in conversations they do not own", async () => {
    prisma.conversation.findUnique.mockResolvedValue({
      id: "conversation-2",
      ownerId: "other-user",
      status: ConversationStatus.active,
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
    const root = await mkdtemp(path.join(tmpdir(), "workbench-runtime-files-"));
    const briefPath = path.join(root, "brief.md");
    const rulesPath = path.join(root, "rules.pdf");
    await Promise.all([writeFile(briefPath, "brief"), writeFile(rulesPath, "rules")]);
    const [safeBriefPath, safeRulesPath] = await Promise.all([realpath(briefPath), realpath(rulesPath)]);
    const localService = new FileAssetService(
      prisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "FILE_UPLOAD_ROOT" ? root : undefined) } as never,
    );
    prisma.fileAsset.findMany.mockResolvedValue([
      fileRecord({ id: "file-2", originalName: "rules.pdf", extension: "pdf", storagePath: rulesPath }),
      fileRecord({ id: "file-1", originalName: "brief.md", extension: "md", storagePath: briefPath }),
    ]);

    const result = await localService.getRuntimeAttachmentFiles(["file-1", "file-2"], "conversation-1");

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
        storagePath: safeBriefPath,
      }),
      expect.objectContaining({
        fileId: "file-2",
        fileName: "rules.pdf",
        fileType: "pdf",
        storagePath: safeRulesPath,
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
      conversation: { findUnique: vi.fn().mockResolvedValue(conversationRecord()) },
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

  it("cleans Multer temp files before rejecting an unsafe conversation id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-upload-root-"));
    const tempDir = await mkdtemp(path.join(tmpdir(), "workbench-upload-tmp-"));
    const file = await multerFile(tempDir, "brief.md", "safe content");
    const localService = new FileAssetService(
      prisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "FILE_UPLOAD_ROOT" ? root : undefined) } as never,
    );

    await expect(localService.uploadConversationFiles(user, "../outside", {}, [file]))
      .rejects.toThrow(BadRequestException);
    expect(prisma.conversation.findUnique).not.toHaveBeenCalled();
    await expect(stat(file.path)).rejects.toThrow();
  });

  it("enforces the per-chat attachment count and byte budget before runtime upload", async () => {
    const countLimited = new FileAssetService(
      prisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "CHAT_ATTACHMENT_MAX_FILES" ? "1" : undefined) } as never,
    );
    await expect(countLimited.getRuntimeAttachmentFiles(["file-1", "file-2"], "conversation-1"))
      .rejects.toThrow("单次对话最多引用 1 个附件");
    expect(prisma.fileAsset.findMany).not.toHaveBeenCalled();

    const byteLimited = new FileAssetService(
      prisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "CHAT_ATTACHMENT_MAX_TOTAL_BYTES" ? "100" : undefined) } as never,
    );
    prisma.fileAsset.findMany.mockResolvedValue([fileRecord({ size: 101 })]);
    await expect(byteLimited.getRuntimeAttachmentFiles(["file-1"], "conversation-1"))
      .rejects.toThrow("单次对话附件总大小不能超过 1MB");
  });

  it("rejects a stored-file symlink that resolves outside the upload root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-runtime-root-"));
    const outsideDir = await mkdtemp(path.join(tmpdir(), "workbench-runtime-outside-"));
    const outsidePath = path.join(outsideDir, "outside.md");
    const linkedPath = path.join(root, "linked.md");
    await writeFile(outsidePath, "outside");
    await symlink(outsidePath, linkedPath);
    const localService = new FileAssetService(
      prisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "FILE_UPLOAD_ROOT" ? root : undefined) } as never,
    );
    prisma.fileAsset.findMany.mockResolvedValue([fileRecord({ storagePath: linkedPath, size: 7 })]);

    await expect(localService.getRuntimeAttachmentFiles(["file-1"], "conversation-1"))
      .rejects.toThrow("附件文件不存在：brief.md");
  });

  it("rejects deleting a conversion that is running", async () => {
    prisma.fileAsset.findUnique.mockResolvedValue({
      ...fileRecord(),
      conversation: conversationRecord(),
    });
    prisma.prototypeConversionJob.findUnique.mockResolvedValue({
      id: "job-1",
      status: PrototypeConversionStatus.running,
    });
    prisma.prototypeConversionJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.deleteFile(user, "file-1")).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("marks parsing files as failed and retryable during startup recovery", async () => {
    prisma.fileAsset.updateMany.mockResolvedValue({ count: 2 });

    await expect(service.failInterruptedParsingFiles()).resolves.toEqual({ count: 2 });
    expect(prisma.fileAsset.updateMany).toHaveBeenCalledWith({
      where: {
        status: FileAssetStatus.parsing,
        deletedAt: null,
      },
      data: {
        status: FileAssetStatus.parse_failed,
        parseError: "文件解析因服务重启中断，请重新解析。",
      },
    });
  });

  it("soft deletes, disables derived knowledge, and removes source and conversion directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workbench-delete-file-"));
    const conversationDir = path.join(root, "conversation-1");
    const sourcePath = path.join(conversationDir, "stored.md");
    const extractedPath = path.join(conversationDir, "file-1_extracted", "page.txt");
    const conversionPath = path.join(conversationDir, "file-1_axure_html", "attempt", "index.html");
    await Promise.all([
      writeNestedFile(sourcePath, "source"),
      writeNestedFile(extractedPath, "parsed"),
      writeNestedFile(conversionPath, "html"),
    ]);
    const record = fileRecord({ storagePath: sourcePath });
    const tx = {
      fileAsset: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      prototypeConversionJob: {
        findUnique: vi.fn().mockResolvedValue({ id: "job-1", status: PrototypeConversionStatus.succeeded }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeItem: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const localPrisma = {
      ...prisma,
      fileAsset: { ...prisma.fileAsset, findUnique: vi.fn().mockResolvedValue({ ...record, conversation: conversationRecord() }) },
      prototypeConversionJob: {
        ...prisma.prototypeConversionJob,
        findUnique: vi.fn().mockResolvedValue({ id: "job-1", status: PrototypeConversionStatus.succeeded }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const localService = new FileAssetService(
      localPrisma as never,
      parser as never,
      { get: vi.fn((key: string) => key === "FILE_UPLOAD_ROOT" ? root : undefined) } as never,
    );

    await expect(localService.deleteFile(user, "file-1")).resolves.toEqual({
      success: true,
      storageCleanupPending: false,
    });
    expect(tx.knowledgeItem.updateMany).toHaveBeenCalledWith({
      where: {
        sourceFileId: "file-1",
        source: KnowledgeSource.file_extraction,
        status: { in: [KnowledgeStatus.active, KnowledgeStatus.draft] },
      },
      data: { status: KnowledgeStatus.disabled, updatedBy: "user-1" },
    });
    await expect(stat(sourcePath)).rejects.toThrow();
    await expect(stat(path.dirname(extractedPath))).rejects.toThrow();
    await expect(stat(path.join(conversationDir, "file-1_axure_html"))).rejects.toThrow();
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

async function writeNestedFile(filePath: string, content: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

function conversationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    ownerId: "user-1",
    status: ConversationStatus.active,
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

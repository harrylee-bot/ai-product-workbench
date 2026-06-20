import { ForbiddenException } from "@nestjs/common";
import {
  FileAssetStatus,
  FileParserType,
  FileStorageProvider,
  ParseResultStatus,
  ProjectStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileAssetService } from "../src/files/file-asset.service";

describe("FileAssetService", () => {
  const prisma = {
    project: {
      findUnique: vi.fn(),
    },
    fileAsset: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
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
    prisma.project.findUnique.mockResolvedValue({
      id: "project-2",
      ownerId: "other-user",
      status: ProjectStatus.draft,
      deletedAt: null,
    });

    await expect(service.listProjectFiles(user, "project-2", {})).rejects.toThrow(ForbiddenException);
  });

  it("returns attachment summaries scoped to the current project", async () => {
    prisma.fileAsset.findMany.mockResolvedValue([
      {
        id: "file-1",
        projectId: "project-1",
        conversationId: null,
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
          projectId: "project-1",
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
      },
    ]);

    const result = await service.getAttachmentSummaries(["file-1", "file-2"], "project-1");

    expect(prisma.fileAsset.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["file-1", "file-2"] },
        projectId: "project-1",
        deletedAt: null,
        status: { not: FileAssetStatus.deleted },
      },
      include: { parseResult: true },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fileId: "file-1",
      fileName: "brief.md",
      parserType: FileParserType.markdown,
      extractedTextPreview: "签到活动需求正文",
    });
  });
});

import {
  FileAssetStatus,
  FileStorageProvider,
  ConversationStatus,
  PrototypeConversionStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PrototypeConversionService } from "../src/files/prototype-conversion.service";

const uploadRoot = path.resolve(process.cwd(), "storage/uploads");

describe("PrototypeConversionService", () => {
  const prisma = {
    fileAsset: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    prototypeConversionJob: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  const parser = {
    parseAxureHtmlDirectory: vi.fn(),
  };
  const config = {
    get: vi.fn(),
  };
  const service = new PrototypeConversionService(prisma as never, parser as never, config as never);
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
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => unknown) => callback(prisma));
    config.get.mockImplementation((key: string) => {
      if (key === "FILE_UPLOAD_ROOT") return "/tmp/uploads";
      return undefined;
    });
  });

  it("enqueues rp files without requiring an Axure worker in the API process", async () => {
    prisma.prototypeConversionJob.upsert.mockResolvedValue(jobRecord());

    const result = await service.enqueueForFile(fileRecord(), {
      source: "rp",
      status: "queued",
      stage: "queued",
      sourceFilePath: "/tmp/prototype.rp",
      expectedOutputKind: "axure_html",
      converter: {
        requiredRuntime: "macos_axure_rp",
        commandConfigured: false,
      },
    });

    expect(prisma.prototypeConversionJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { fileAssetId: "file-rp" },
      create: expect.objectContaining({
        status: PrototypeConversionStatus.queued,
        stage: "queued",
        sourceFilePath: "/tmp/prototype.rp",
      }),
    }));
    expect(result).toMatchObject({
      fileAssetId: "file-rp",
      status: PrototypeConversionStatus.queued,
      stage: "queued",
    });
  });

  it("keeps manual conversion runs queued when no converter command is configured", async () => {
    prisma.fileAsset.findUnique.mockResolvedValue(fileRecord({ conversation: conversationRecord() }));
    prisma.prototypeConversionJob.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...jobRecord(),
        fileAsset: fileRecord({ conversation: conversationRecord() }),
      })
      .mockResolvedValueOnce(jobRecord({
        stage: "waiting_for_worker",
        errorMessage: "AXURE_RP_CONVERTER_BIN 未配置，等待 macOS Axure Worker 处理。",
      }));
    prisma.prototypeConversionJob.upsert.mockResolvedValue(jobRecord());
    prisma.prototypeConversionJob.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.runConversionForFile(user, "file-rp");

    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: PrototypeConversionStatus.queued, stage: "queued" },
      data: expect.objectContaining({
        status: PrototypeConversionStatus.queued,
        stage: "waiting_for_worker",
      }),
    });
    expect(result.job).toMatchObject({
      status: PrototypeConversionStatus.queued,
      stage: "waiting_for_worker",
    });
  });

  it("does not restart a conversion job that is already running", async () => {
    prisma.fileAsset.findUnique.mockResolvedValue(fileRecord({ conversation: conversationRecord() }));
    prisma.prototypeConversionJob.findUnique.mockResolvedValue(jobRecord({
      status: PrototypeConversionStatus.running,
      stage: "converting_rp_to_html",
    }));

    const result = await service.runConversionForFile(user, "file-rp");

    expect(prisma.prototypeConversionJob.upsert).not.toHaveBeenCalled();
    expect(prisma.prototypeConversionJob.updateMany).not.toHaveBeenCalled();
    expect(result.job).toMatchObject({
      status: PrototypeConversionStatus.running,
      stage: "converting_rp_to_html",
    });
  });

  it("returns the latest job without touching output when another runner wins the lock", async () => {
    config.get.mockImplementation((key: string) => {
      if (key === "FILE_UPLOAD_ROOT") return "/tmp/uploads";
      if (key === "AXURE_RP_CONVERTER_BIN") return "/bin/true";
      return undefined;
    });
    prisma.prototypeConversionJob.findUnique
      .mockResolvedValueOnce({
        ...jobRecord({ status: PrototypeConversionStatus.queued }),
        fileAsset: fileRecord({ conversation: conversationRecord() }),
      })
      .mockResolvedValueOnce(jobRecord({
        status: PrototypeConversionStatus.running,
        stage: "converting_rp_to_html",
      }));
    prisma.prototypeConversionJob.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runConversionJob("job-1");

    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "job-1",
        status: PrototypeConversionStatus.queued,
        stage: "queued",
      }),
    }));
    expect(parser.parseAxureHtmlDirectory).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: PrototypeConversionStatus.running,
      stage: "converting_rp_to_html",
    });
  });

  it("falls back to the default converter timeout when the environment value is invalid", () => {
    config.get.mockImplementation((key: string) => {
      if (key === "AXURE_RP_CONVERTER_BIN") return "/bin/true";
      if (key === "AXURE_RP_CONVERTER_TIMEOUT_MS") return "abc";
      return undefined;
    });

    const command = (service as unknown as { getConverterCommand(): { timeoutMs: number } }).getConverterCommand();

    expect(command.timeoutMs).toBe(180_000);
  });

  it("backfills all existing rp files by creating conversion jobs before document generation", async () => {
    prisma.fileAsset.findMany.mockResolvedValue([
      fileRecord({ id: "file-rp-1", originalName: "活动交易快照.rp", prototypeConversionJob: null }),
      fileRecord({ id: "file-rp-2", originalName: "奖品运营.rp", prototypeConversionJob: null }),
    ]);
    prisma.prototypeConversionJob.upsert
      .mockResolvedValueOnce(jobRecord({ id: "job-1", fileAssetId: "file-rp-1" }))
      .mockResolvedValueOnce(jobRecord({ id: "job-2", fileAssetId: "file-rp-2" }));

    const result = await service.backfillRpConversions({ run: false, background: false });

    expect(prisma.fileAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        extension: "rp",
        deletedAt: null,
      }),
      take: 500,
    }));
    expect(prisma.prototypeConversionJob.upsert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      matchedCount: 2,
      enqueuedCount: 2,
      skippedCount: 0,
      runRequested: false,
    });
  });

  it("can synchronously mark a backfill as waiting for a worker when no converter is configured", async () => {
    prisma.fileAsset.findMany.mockResolvedValue([
      fileRecord({ id: "file-rp-1", originalName: "活动交易快照.rp", prototypeConversionJob: null }),
    ]);
    prisma.prototypeConversionJob.upsert.mockResolvedValue(jobRecord({ id: "job-1", fileAssetId: "file-rp-1" }));
    prisma.prototypeConversionJob.findUnique.mockResolvedValue({
      ...jobRecord({ id: "job-1", fileAssetId: "file-rp-1" }),
      fileAsset: fileRecord({
        id: "file-rp-1",
        storagePath: path.join(uploadRoot, "conversation-1", "file-rp-1.rp"),
        conversation: conversationRecord(),
      }),
    });
    prisma.prototypeConversionJob.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.backfillRpConversions({ run: true, background: false });

    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", status: PrototypeConversionStatus.queued, stage: "queued" },
      data: expect.objectContaining({
        status: PrototypeConversionStatus.queued,
        stage: "waiting_for_worker",
      }),
    });
    expect(result.runResult).toEqual({
      attempted: 1,
      completed: 1,
      failed: 0,
    });
  });

  it("fails interrupted jobs and leaves queued work explicitly retryable when no worker is configured", async () => {
    prisma.prototypeConversionJob.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.prototypeConversionJob.findMany.mockResolvedValue([
      { id: "job-1" },
      { id: "job-2" },
      { id: "job-3" },
    ]);

    await expect(service.recoverInterruptedJobs(3)).resolves.toEqual({
      interruptedCount: 2,
      queuedCount: 3,
      resumedCount: 0,
      waitingCount: 3,
      deferredCount: 0,
    });
    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: { status: PrototypeConversionStatus.running },
      data: {
        status: PrototypeConversionStatus.failed,
        stage: "interrupted_by_restart",
        errorMessage: "原型转换因服务重启中断，可重新执行。",
        completedAt: expect.any(Date),
      },
    });
    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["job-1", "job-2", "job-3"] },
        status: PrototypeConversionStatus.queued,
      },
      data: {
        stage: "waiting_for_worker",
        errorMessage: "AXURE_RP_CONVERTER_BIN 未配置，等待转换 Worker。",
      },
    });
    expect(prisma.prototypeConversionJob.updateMany).toHaveBeenNthCalledWith(3, {
      where: {
        status: PrototypeConversionStatus.queued,
        id: { notIn: ["job-1", "job-2", "job-3"] },
        fileAsset: {
          deletedAt: null,
          status: { not: FileAssetStatus.deleted },
        },
      },
      data: {
        stage: "recovery_deferred",
        errorMessage: "启动恢复批次已达上限，可手动重新执行或等待下次恢复。",
      },
    });
  });

  it("resumes a bounded queued batch when the local converter is available", async () => {
    config.get.mockImplementation((key: string) => {
      if (key === "AXURE_RP_CONVERTER_BIN") return "/bin/true";
      return undefined;
    });
    prisma.prototypeConversionJob.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.prototypeConversionJob.findMany.mockResolvedValue([{ id: "job-1" }]);
    const runInBackground = vi.spyOn(
      service as unknown as { runJobsInBackground(jobIds: string[]): void },
      "runJobsInBackground",
    ).mockImplementation(() => undefined);

    await expect(service.recoverInterruptedJobs(1)).resolves.toEqual({
      interruptedCount: 0,
      queuedCount: 1,
      resumedCount: 1,
      waitingCount: 0,
      deferredCount: 0,
    });
    expect(runInBackground).toHaveBeenCalledWith(["job-1"]);
    runInBackground.mockRestore();
  });
});

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
    id: "file-rp",
    conversationId: "conversation-1",
    messageId: null,
    uploadedBy: "user-1",
    originalName: "prototype.rp",
    storedName: "prototype.rp",
    mimeType: "application/octet-stream",
    extension: "rp",
    size: 128,
    storageProvider: FileStorageProvider.local,
    storagePath: path.join(uploadRoot, "conversation-1", "prototype.rp"),
    publicUrl: null,
    status: FileAssetStatus.parsed,
    parseError: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    conversation: conversationRecord(),
    ...overrides,
  };
}

function jobRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    fileAssetId: "file-rp",
    conversationId: "conversation-1",
    status: PrototypeConversionStatus.queued,
    stage: "queued",
    sourceFilePath: "/tmp/prototype.rp",
    outputPath: null,
    outputEntryFile: null,
    outputZipPath: null,
    pageCount: 0,
    screenshotCount: 0,
    converterName: "axure-rp-html-worker",
    converterVersion: null,
    errorMessage: null,
    metadata: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

import { ForbiddenException } from "@nestjs/common";
import { FileStorageProvider, UserRole, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";

describe("AuthService", () => {
  const prisma = {
    $transaction: vi.fn(),
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const jwtService = {
    signAsync: vi.fn(),
    verifyAsync: vi.fn(),
  };
  const configService = { get: vi.fn() };
  const service = new AuthService(
    prisma as never,
    jwtService as never,
    configService as never,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in with username and returns an accessToken without passwordHash", async () => {
    const passwordHash = await bcrypt.hash("User123456", 4);
    const user = {
      id: "user-1",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash,
      role: UserRole.user,
      status: UserStatus.active,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.user.findFirst.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, lastLoginAt: new Date() });
    jwtService.signAsync.mockResolvedValue("signed-token");

    const result = await service.login(
      { account: "zhangsan", password: "User123456" },
    );

    expect(result.accessToken).toBe("signed-token");
    expect(result.user).toMatchObject({
      id: "user-1",
      username: "zhangsan",
      role: UserRole.user,
      status: UserStatus.active,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
  });

  it("rejects disabled users with the required message", async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: "user-disabled",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash: await bcrypt.hash("User123456", 4),
      role: UserRole.user,
      status: UserStatus.disabled,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.login({ account: "zhangsan", password: "User123456" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("uses one message for missing account and bad password", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ account: "missing", password: "bad" }),
    ).rejects.toThrow("账号或密码错误");
  });

  it("returns an empty session without token or invalid token", async () => {
    await expect(service.session()).resolves.toBeNull();

    jwtService.verifyAsync.mockRejectedValue(new Error("bad token"));
    await expect(service.session("bad-token")).resolves.toBeNull();
  });

  it("returns the active user for a valid session token", async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: "user-1", userId: "user-1", role: UserRole.user });
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      username: "zhangsan",
      email: "zhangsan@example.local",
      displayName: "张三",
      passwordHash: "hidden",
      role: UserRole.user,
      status: UserStatus.active,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service.session("good-token")).resolves.toMatchObject({
      id: "user-1",
      username: "zhangsan",
      status: UserStatus.active,
    });
  });

  it("deletes the authenticated user and all owned conversation data atomically", async () => {
    const tx = accountDeletionTransaction();
    tx.user.findUnique.mockResolvedValue({
      id: "user-1",
      username: "smoke-user",
      email: "smoke@example.test",
      role: UserRole.user,
    });
    tx.conversation.findMany.mockResolvedValue([{ id: "conversation-1" }]);
    tx.message.findMany.mockResolvedValue([{ id: "message-1" }]);
    tx.runtimeRunLog.findMany.mockResolvedValue([{ id: "run-1" }]);
    tx.fileAsset.findMany.mockResolvedValue([
      {
        id: "file-1",
        conversationId: "conversation-1",
        storagePath: path.resolve(process.cwd(), "storage/uploads/conversation-1/file-1.md"),
        storageProvider: FileStorageProvider.local,
      },
    ]);
    tx.requirementDocument.findMany.mockResolvedValue([{ id: "prd-1" }]);
    tx.knowledgeItem.findMany.mockResolvedValue([{ id: "knowledge-1" }]);
    tx.deerFlowThreadBinding.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      service.deleteMe({
        id: "user-1",
        username: "smoke-user",
        email: "smoke@example.test",
        displayName: "Smoke",
        role: UserRole.user,
        status: UserStatus.active,
      }),
    ).resolves.toEqual({
      success: true,
      cleanupComplete: true,
      cleanup: {
        deerFlowThreads: { attempted: 0, completed: 0, failed: 0 },
        localFiles: { attempted: 4, completed: 4, failed: 0 },
      },
    });

    expect(tx.suggestion.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1" },
          { documentId: { in: ["prd-1"] } },
        ],
      },
    });

    expect(tx.knowledgeVersion.deleteMany).toHaveBeenCalledWith({
      where: { knowledgeItemId: { in: ["knowledge-1"] } },
    });
    expect(tx.modelCallLog.deleteMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
    });
    expect(tx.fileChunk.deleteMany).toHaveBeenCalledWith({
      where: { fileAssetId: { in: ["file-1"] } },
    });
    expect(tx.message.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["message-1"] } },
    });
    expect(tx.conversation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["conversation-1"] } },
    });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
    expect(tx.message.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.conversation.deleteMany.mock.invocationCallOrder[0],
    );
    expect(tx.conversation.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.delete.mock.invocationCallOrder[0],
    );
  });

  it("does not allow an administrator account to self-delete", async () => {
    const tx = accountDeletionTransaction();
    tx.user.findUnique.mockResolvedValue({
      id: "admin-1",
      username: "admin",
      email: null,
      role: UserRole.admin,
    });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await expect(
      service.deleteMe({
        id: "admin-1",
        username: "admin",
        displayName: "Admin",
        role: UserRole.admin,
        status: UserStatus.active,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(tx.user.delete).not.toHaveBeenCalled();
  });

  it("removes the account's DeerFlow thread after the database transaction", async () => {
    const tx = accountDeletionTransaction();
    tx.user.findUnique.mockResolvedValue({
      id: "user-1",
      username: "smoke-user",
      email: null,
      role: UserRole.user,
    });
    tx.deerFlowThreadBinding.findMany.mockResolvedValue([
      { deerFlowThreadId: "thread/with spaces" },
    ]);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    configService.get.mockImplementation((key) =>
      key === "DEERFLOW_GATEWAY_URL"
        ? "http://gateway.local/"
        : key === "DEERFLOW_INTERNAL_AUTH_TOKEN"
          ? "internal-secret"
          : undefined,
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);

    await service.deleteMe({
      id: "user-1",
      username: "smoke-user",
      displayName: "Smoke",
      role: UserRole.user,
      status: UserStatus.active,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.local/api/threads/thread%2Fwith%20spaces",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          "X-DeerFlow-Owner-User-Id": "user-1",
          "X-DeerFlow-Internal-Token": "internal-secret",
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps the account transaction retryable when DeerFlow cleanup fails", async () => {
    const tx = accountDeletionTransaction();
    tx.user.findUnique.mockResolvedValue({
      id: "user-1",
      username: "smoke-user",
      email: null,
      role: UserRole.user,
    });
    tx.deerFlowThreadBinding.findMany.mockResolvedValue([
      { deerFlowThreadId: "thread-1" },
    ]);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    await expect(service.deleteMe({
      id: "user-1",
      username: "smoke-user",
      displayName: "Smoke",
      role: UserRole.user,
      status: UserStatus.active,
    })).rejects.toThrow("Agent 线程清理失败");
    expect(tx.deerFlowThreadBinding.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
  });
});

function accountDeletionTransaction() {
  const deleteOnlyDelegates = [
    "comment",
    "suggestion",
    "vote",
    "knowledgeVersion",
    "knowledgeCandidate",
    "knowledgeRetrievalLog",
    "vibeStreamEventLog",
    "modelCallLog",
    "shareLink",
    "rollbackRecord",
    "qAReport",
    "prototypeVersion",
    "prototypeArtifact",
    "prototypeSpecRecord",
    "requirementDocumentVersion",
    "conversationDesignChangeLog",
    "conversationDesignVersion",
    "conversationDesignState",
    "prototypeConversionJob",
    "fileChunk",
    "fileParseResult",
    "constraintRule",
    "stream",
    "loginAuditLog",
    "adminAuditLog",
  ];
  const tx = Object.fromEntries(
    deleteOnlyDelegates.map((name) => [
      name,
      { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    ]),
  ) as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

  tx.user = {
    findUnique: vi.fn(),
    delete: vi.fn().mockResolvedValue({ id: "user-1" }),
  };
  tx.deerFlowThreadBinding = {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  for (const name of [
    "conversation",
    "message",
    "runtimeRunLog",
    "fileAsset",
    "knowledgeItem",
    "requirementDocument",
  ]) {
    tx[name] = {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
  }
  return tx;
}

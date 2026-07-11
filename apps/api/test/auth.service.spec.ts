import { ForbiddenException } from "@nestjs/common";
import { FileStorageProvider, UserRole, UserStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth/auth.service";

describe("AuthService", () => {
  const prisma = {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    loginAuditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  const jwtService = {
    signAsync: vi.fn(),
    verifyAsync: vi.fn(),
  };
  const configValues = new Map<string, string>();
  const configService = { get: vi.fn((key: string) => configValues.get(key)) };
  const service = new AuthService(prisma as never, jwtService as never, configService as never);

  beforeEach(() => {
    vi.clearAllMocks();
    configValues.clear();
    configService.get.mockImplementation((key: string) => configValues.get(key));
    prisma.loginAuditLog.create.mockResolvedValue({ id: "audit-1" });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof prisma) => unknown) => callback(prisma));
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
      authVersion: 3,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.user.findFirst.mockResolvedValue(user);
    prisma.user.update.mockResolvedValue({ ...user, lastLoginAt: new Date() });
    jwtService.signAsync.mockResolvedValue("signed-token");

    const result = await service.login(
      { account: "zhangsan", password: "User123456" },
      { ip: "127.0.0.1", userAgent: "vitest" },
    );

    expect(result.accessToken).toBe("signed-token");
    expect(result.user).toMatchObject({
      id: "user-1",
      username: "zhangsan",
      role: UserRole.user,
      status: UserStatus.active,
    });
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
      authVersion: 3,
    });
    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        account: "zhangsan",
        success: true,
        ip: "127.0.0.1",
        userAgent: "vitest",
      }),
    });
    expect(JSON.stringify(prisma.loginAuditLog.create.mock.calls)).not.toContain("User123456");
    expect(JSON.stringify(prisma.loginAuditLog.create.mock.calls)).not.toContain("signed-token");
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
      authVersion: 1,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.login({ account: "zhangsan", password: "User123456" }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-disabled",
        success: false,
        failReason: "account_disabled",
      }),
    });
  });

  it("uses one message for missing account and bad password", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ account: "missing", password: "bad" }),
    ).rejects.toThrow("账号或密码错误");
    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        account: "missing",
        success: false,
        failReason: "account_not_found",
      }),
    });
  });

  it("audits an invalid password without persisting the password", async () => {
    prisma.user.findFirst.mockResolvedValue(userRecord({
      passwordHash: await bcrypt.hash("Correct123", 4),
    }));

    await expect(service.login({ account: "zhangsan", password: "Wrong123" }))
      .rejects.toThrow("账号或密码错误");
    expect(prisma.loginAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        success: false,
        failReason: "invalid_password",
      }),
    });
    expect(JSON.stringify(prisma.loginAuditLog.create.mock.calls)).not.toContain("Wrong123");
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
      authVersion: 0,
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

  it("rejects a session whose token auth version is stale", async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: "user-1",
      userId: "user-1",
      role: UserRole.user,
      authVersion: 2,
    });
    prisma.user.findUnique.mockResolvedValue(userRecord({ authVersion: 3 }));

    await expect(service.session("stale-token")).resolves.toBeNull();
  });

  it("increments authVersion for logout-all", async () => {
    prisma.user.update.mockResolvedValue(userRecord({ authVersion: 4 }));

    await expect(service.logoutAll("user-1")).resolves.toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { authVersion: { increment: 1 } },
    });
  });

  it("keeps public registration closed by default in production", async () => {
    configValues.set("NODE_ENV", "production");

    expect(service.registrationStatus()).toEqual({ enabled: false });

    await expect(service.register({
      username: "new-user",
      password: "User123456",
    })).rejects.toThrow("公开注册未启用");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("allows public registration only when the explicit switch is enabled", async () => {
    configValues.set("NODE_ENV", "production");
    configValues.set("PUBLIC_REGISTRATION_ENABLED", "true");
    expect(service.registrationStatus()).toEqual({ enabled: true });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(userRecord({
      id: "new-user",
      username: "new-user",
      authVersion: 0,
    }));
    prisma.user.update.mockResolvedValue(userRecord({ id: "new-user", username: "new-user" }));
    jwtService.signAsync.mockResolvedValue("registered-token");

    await expect(service.register({
      username: "new-user",
      password: "User123456",
    })).resolves.toMatchObject({ accessToken: "registered-token" });
    expect(jwtService.signAsync).toHaveBeenCalledWith(expect.objectContaining({ authVersion: 0 }));
  });
});

function userRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: "zhangsan",
    email: "zhangsan@example.local",
    displayName: "张三",
    passwordHash: "hidden",
    role: UserRole.user,
    status: UserStatus.active,
    authVersion: 0,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

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

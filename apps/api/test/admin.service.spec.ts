import {
  AdminAuditTargetType,
  RuntimeRunStatus,
  KnowledgeCandidateStatus,
  ModelCallStatus,
  ConversationStatus,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../src/admin/admin-audit.service";
import { AdminService } from "../src/admin/admin.service";

describe("Admin module services", () => {
  const prisma = {
    $transaction: vi.fn(),
    user: { count: vi.fn() },
    conversation: { count: vi.fn(), findUnique: vi.fn() },
    runtimeRunLog: { count: vi.fn(), findUnique: vi.fn() },
    modelCallLog: { count: vi.fn() },
    knowledgeCandidate: { count: vi.fn() },
    fileAsset: { count: vi.fn() },
    qAReport: { count: vi.fn() },
    adminAuditLog: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  };
  const service = new AdminService(prisma as never);
  const audit = new AdminAuditService(prisma as never);
  const admin = {
    id: "admin-1",
    username: "admin",
    displayName: "管理员",
    role: UserRole.admin,
    status: UserStatus.active,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (items) => Promise.all(items));
  });

  it("aggregates dashboard stats from operational tables", async () => {
    prisma.user.count.mockResolvedValue(2);
    prisma.conversation.count.mockResolvedValue(4);
    prisma.runtimeRunLog.count.mockResolvedValue(5);
    prisma.modelCallLog.count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3);
    prisma.knowledgeCandidate.count.mockResolvedValue(6);
    prisma.fileAsset.count.mockResolvedValue(1);
    prisma.qAReport.count.mockResolvedValue(1);

    const result = await service.getDashboardStats();

    expect(result).toMatchObject({
      userCount: 2,
      conversationCount: 4,
      todayRuntimeRunCount: 5,
      todayModelCallCount: 12,
      todayFailedModelCallCount: 3,
      pendingKnowledgeCandidateCount: 6,
      failedFileParseCount: 1,
      qaFailedReportCount: 1,
    });
    expect(prisma.knowledgeCandidate.count).toHaveBeenCalledWith({
      where: { status: KnowledgeCandidateStatus.pending },
    });
    expect(prisma.qAReport.count).toHaveBeenCalledWith({
      where: { status: "failed" },
    });
  });

  it("writes sanitized admin audit details", async () => {
    prisma.adminAuditLog.create.mockResolvedValue({});

    await audit.record({
      admin,
      action: "model_provider.update",
      targetType: AdminAuditTargetType.model_provider,
      targetId: "provider-1",
      detail: {
        name: "OpenAI",
        apiKey: "sk-secret",
        nested: { authorization: "Bearer token" },
      },
      meta: { ip: "127.0.0.1", userAgent: "vitest" },
    });

    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "model_provider.update",
        adminUserId: "admin-1",
        targetId: "provider-1",
        detail: {
          name: "OpenAI",
          apiKey: "****",
          nested: { authorization: "****" },
        },
      }),
    });
  });

  it("returns runtime run details with stream events", async () => {
    prisma.runtimeRunLog.findUnique.mockResolvedValue({
      id: "run-1",
      conversationId: "conversation-1",
      userId: "user-1",
      intent: null,
      status: RuntimeRunStatus.succeeded,
      inputSummary: "用户需求摘要",
      outputSummary: "输出摘要",
      result: null,
      errorMessage: null,
      traceId: "trace-1",
      startedAt: new Date("2026-06-21T08:00:00Z"),
      endedAt: new Date("2026-06-21T08:00:05Z"),
      durationMs: 5000,
      conversation: { id: "conversation-1", title: "默认会话" },
      user: { id: "user-1", username: "zhangsan", displayName: "张三" },
      streamEvents: [
        {
          id: "event-1",
          eventType: "qa_completed",
          payload: {
            eventType: "qa_completed",
            payload: {
              data: {
                qaReport: {
                  gate: { status: "warning", reportId: "qa-1" },
                  issues: [
                    {
                      id: "issue-1",
                      title: "需要复核",
                      severity: "minor",
                      status: "open",
                    },
                  ],
                },
              },
            },
          },
          createdAt: new Date("2026-06-21T08:00:04Z"),
        },
      ],
    });

    const result = await service.getRuntimeRun("run-1");

    expect(result).toMatchObject({
      id: "run-1",
      traceId: "trace-1",
      conversationTitle: "默认会话",
      streamEvents: [
        {
          eventType: "qa_completed",
        },
      ],
    });
  });
});

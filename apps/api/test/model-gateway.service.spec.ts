import {
  ModelCallStatus,
  ModelResponseFormat,
  ModelTaskType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyEncryptionService } from "../src/model-gateway/api-key-encryption.service";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";
import { ModelGatewayService } from "../src/model-gateway/model-gateway.service";

describe("ModelGatewayService", () => {
  const encryption = new ApiKeyEncryptionService();
  const apiKeyEncrypted = encryption.encrypt("sk-test-secret");
  const prisma = {
    modelTaskProfile: {
      findUnique: vi.fn(),
    },
    modelCallLog: {
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const adapter = {
    chat: vi.fn(),
    stream: vi.fn(),
  };
  const service = new ModelGatewayService(prisma as never, encryption, adapter as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.modelTaskProfile.findUnique.mockResolvedValue(baseProfile(apiKeyEncrypted));
    prisma.modelCallLog.create.mockResolvedValue({
      id: "log-1",
      createdAt: new Date(),
    });
    prisma.modelCallLog.update.mockResolvedValue({});
  });

  it("generates text through the resolved task profile and records success log", async () => {
    adapter.chat.mockResolvedValue({
      content: "模型回复",
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    });

    const result = await service.generateText({
      taskType: ModelTaskType.general_chat,
      agentName: "general_agent",
      messages: [{ role: "user", content: "你好" }],
    });

    expect(result).toMatchObject({
      content: "模型回复",
      modelCallLogId: "log-1",
    });
    expect(adapter.chat).toHaveBeenCalledWith({
      route: expect.objectContaining({
        apiKey: "sk-test-secret",
        modelName: "gpt-test",
        timeoutMs: 30000,
      }),
      messages: [{ role: "user", content: "你好" }],
      responseFormat: ModelResponseFormat.text,
    });
    expect(prisma.modelCallLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: ModelCallStatus.running,
        inputSummary: "user: 你好",
      }),
    });
    expect(prisma.modelCallLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: ModelCallStatus.succeeded,
        outputSummary: "模型回复",
        totalTokens: 13,
      }),
    });
  });

  it("strips markdown fences and parses JSON output", async () => {
    adapter.chat.mockResolvedValue({
      content: "```json\n{\"intent\":\"create_prd\"}\n```",
      usage: { totalTokens: 9 },
    });

    const result = await service.generateJson<{ intent: string }>({
      taskType: ModelTaskType.intent_detection,
      messages: [{ role: "user", content: "做一个会员签到" }],
    });

    expect(result.data.intent).toBe("create_prd");
    expect(adapter.chat).toHaveBeenCalledTimes(1);
  });

  it("retries invalid JSON once and fails with MODEL_JSON_PARSE_FAILED", async () => {
    adapter.chat.mockResolvedValueOnce({ content: "不是 JSON" }).mockResolvedValueOnce({
      content: "仍然不是 JSON",
    });

    await expect(
      service.generateJson({
        taskType: ModelTaskType.intent_detection,
        messages: [{ role: "user", content: "做一个会员签到" }],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_JSON_PARSE_FAILED",
    });

    expect(adapter.chat).toHaveBeenCalledTimes(2);
    expect(prisma.modelCallLog.update).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: ModelCallStatus.failed,
        errorCode: "MODEL_JSON_PARSE_FAILED",
        outputSummary: "仍然不是 JSON",
      }),
    });
  });

  it("throws a stable error when the task profile is missing", async () => {
    prisma.modelTaskProfile.findUnique.mockResolvedValue(null);

    await expect(
      service.generateText({
        taskType: ModelTaskType.qa_check,
        messages: [{ role: "user", content: "检查" }],
      }),
    ).rejects.toBeInstanceOf(ModelGatewayError);
  });
});

function baseProfile(apiKeyEncrypted: string) {
  return {
    id: "profile-1",
    taskType: ModelTaskType.general_chat,
    modelConfigId: "config-1",
    temperature: 0.3,
    maxTokens: 1024,
    responseFormat: ModelResponseFormat.text,
    retryCount: 1,
    timeoutMs: 30000,
    isEnabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    modelConfig: {
      id: "config-1",
      providerId: "provider-1",
      displayName: "GPT Test",
      modelName: "gpt-test",
      contextWindow: null,
      maxOutputTokens: null,
      supportsStreaming: true,
      supportsJsonMode: true,
      defaultTemperature: 0.2,
      defaultMaxTokens: 2048,
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      provider: {
        id: "provider-1",
        name: "Test Provider",
        type: "openai_compatible",
        baseUrl: "https://example.test",
        apiKeyEncrypted,
        defaultHeaders: null,
        timeoutMs: 60000,
        isDefault: true,
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  };
}

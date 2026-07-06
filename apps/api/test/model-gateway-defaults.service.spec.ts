import { ModelResponseFormat, ModelTaskType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelGatewayDefaultsService } from "../src/model-gateway/model-gateway-defaults.service";

describe("ModelGatewayDefaultsService", () => {
  const encryption = {
    encrypt: vi.fn(() => "encrypted-provider-key"),
  };

  let tx: ReturnType<typeof createTx>;
  let service: ModelGatewayDefaultsService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DEFAULT_MODEL_PROVIDER_NAME", "datatoken");
    vi.stubEnv("DEFAULT_MODEL_BASE_URL", "https://datatoken.shop");
    vi.stubEnv("DEFAULT_MODEL_API_KEY", "sk-test-provider-key");
    vi.stubEnv("MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER", "true");

    tx = createTx();
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    };
    service = new ModelGatewayDefaultsService(prisma as never, encryption as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the previous single default model behavior", async () => {
    vi.stubEnv("DEFAULT_MODEL_NAME", "gpt-default");

    await service.onModuleInit();

    expect(tx.modelConfig.create).toHaveBeenCalledTimes(1);
    expect(tx.modelConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelName: "gpt-default",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        defaultMaxTokens: 4096,
      }),
    });
    expect(tx.modelTaskProfile.upsert).toHaveBeenCalledTimes(Object.values(ModelTaskType).length);
    expect(profileUpsertFor(ModelTaskType.general_chat, tx)).toMatchObject({
      create: {
        modelConfigId: "config-gpt-default",
        responseFormat: ModelResponseFormat.text,
      },
    });
    expect(profileUpsertFor(ModelTaskType.prototype_code_generation, tx)).toMatchObject({
      create: {
        modelConfigId: "config-gpt-default",
        maxTokens: 8192,
        responseFormat: ModelResponseFormat.json,
      },
    });
  });

  it("routes task profiles to capability and per-task model overrides", async () => {
    vi.stubEnv("DEFAULT_MODEL_NAME", "gpt-default");
    vi.stubEnv("DEFAULT_MODEL_FAST_NAME", "fast-model");
    vi.stubEnv("DEFAULT_MODEL_REASONING_NAME", "reasoning-model");
    vi.stubEnv("DEFAULT_MODEL_LONG_CONTEXT_NAME", "long-context-model");
    vi.stubEnv("DEFAULT_MODEL_CODE_NAME", "code-model");
    vi.stubEnv("DEFAULT_MODEL_TASK_QA_CHECK_NAME", "qa-model");

    await service.onModuleInit();

    expect(createdModelNames(tx)).toEqual([
      "fast-model",
      "reasoning-model",
      "code-model",
      "qa-model",
      "long-context-model",
    ]);
    expect(tx.modelConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelName: "code-model",
        maxOutputTokens: 16000,
        defaultTemperature: 0.15,
        defaultMaxTokens: 8192,
      }),
    });
    expect(tx.modelConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelName: "long-context-model",
        contextWindow: 1000000,
      }),
    });
    expect(profileUpsertFor(ModelTaskType.intent_detection, tx)).toMatchObject({
      create: { modelConfigId: "config-fast-model" },
    });
    expect(profileUpsertFor(ModelTaskType.prd_generation, tx)).toMatchObject({
      create: { modelConfigId: "config-reasoning-model" },
    });
    expect(profileUpsertFor(ModelTaskType.prototype_code_generation, tx)).toMatchObject({
      create: { modelConfigId: "config-code-model" },
    });
    expect(profileUpsertFor(ModelTaskType.qa_check, tx)).toMatchObject({
      create: { modelConfigId: "config-qa-model" },
    });
    expect(profileUpsertFor(ModelTaskType.knowledge_extraction, tx)).toMatchObject({
      create: { modelConfigId: "config-long-context-model" },
    });
  });
});

function createTx() {
  return {
    modelProvider: {
      updateMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: "provider-1",
        name: "datatoken",
        baseUrl: "https://datatoken.shop",
      }),
    },
    modelConfig: {
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn(async ({ data }) => ({ id: `config-${data.modelName}`, ...data })),
      create: vi.fn(async ({ data }) => ({ id: `config-${data.modelName}`, ...data })),
      updateMany: vi.fn(),
    },
    modelTaskProfile: {
      upsert: vi.fn(),
    },
  };
}

function profileUpsertFor(taskType: ModelTaskType, tx: ReturnType<typeof createTx>) {
  return tx.modelTaskProfile.upsert.mock.calls.find(([input]) => input.where.taskType === taskType)?.[0];
}

function createdModelNames(tx: ReturnType<typeof createTx>) {
  return tx.modelConfig.create.mock.calls.map(([input]) => input.data.modelName);
}

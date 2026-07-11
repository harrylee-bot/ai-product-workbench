import { ModelTaskType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeModelPolicyService } from "../src/ai/runtime-model-policy.service";

describe("RuntimeModelPolicyService", () => {
  const prisma = {
    modelConfig: { findMany: vi.fn() },
    modelTaskProfile: { findUnique: vi.fn() },
  };
  const service = new RuntimeModelPolicyService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DEERFLOW_MODEL_PROVIDER", "deerflow");
    vi.stubEnv("DEERFLOW_MODEL_NAME", "default-model");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the enabled database task profile as the runtime default", async () => {
    prisma.modelTaskProfile.findUnique.mockResolvedValue({
      isEnabled: true,
      modelConfig: {
        modelName: "admin-selected-model",
        isEnabled: true,
        provider: { isEnabled: true },
      },
    });

    await expect(service.resolve({
      taskType: ModelTaskType.prd_generation,
    })).resolves.toBe("admin-selected-model");
  });

  it("rejects a selected model disabled by the admin control plane", async () => {
    prisma.modelConfig.findMany.mockResolvedValue([{
      modelName: "default-model",
      isEnabled: false,
      provider: { isEnabled: true },
    }]);

    await expect(service.resolve({
      selectedModelId: "deerflow/default-model",
      taskType: ModelTaskType.conversation_design,
    })).rejects.toMatchObject({ status: 400 });
  });

  it("allows a selected model when any same-name provider route remains enabled", async () => {
    prisma.modelConfig.findMany.mockResolvedValue([
      {
        modelName: "default-model",
        isEnabled: false,
        provider: { isEnabled: true },
      },
      {
        modelName: "default-model",
        isEnabled: true,
        provider: { isEnabled: true },
      },
    ]);

    await expect(service.resolve({
      selectedModelId: "deerflow/default-model",
      taskType: ModelTaskType.conversation_design,
    })).resolves.toBe("default-model");
  });
});

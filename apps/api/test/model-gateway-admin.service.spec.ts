import { ModelProviderType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyEncryptionService } from "../src/model-gateway/api-key-encryption.service";
import { ModelGatewayAdminService } from "../src/model-gateway/model-gateway-admin.service";

describe("ModelGatewayAdminService", () => {
  const encryption = new ApiKeyEncryptionService();
  const provider = {
    id: "provider-1",
    name: "OpenAI Proxy",
    type: ModelProviderType.openai_compatible,
    baseUrl: "https://api.example.test",
    apiKeyEncrypted: encryption.encrypt("sk-live-secretabcd"),
    defaultHeaders: { "X-Trace": "1" },
    timeoutMs: 60000,
    isDefault: true,
    isEnabled: true,
    createdAt: new Date("2026-06-20T08:00:00Z"),
    updatedAt: new Date("2026-06-20T08:00:00Z"),
  };
  const prisma = {
    $transaction: vi.fn(),
    modelProvider: {
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    modelConfig: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    modelTaskProfile: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    modelCallLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  const service = new ModelGatewayAdminService(prisma as never, encryption);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("masks API keys and never returns encrypted API key fields", async () => {
    prisma.modelProvider.findMany.mockResolvedValue([provider]);

    const result = await service.listProviders();

    expect(result.items[0]).toMatchObject({
      id: "provider-1",
      hasApiKey: true,
      apiKeyMasked: "sk-****abcd",
    });
    expect(result.items[0]).not.toHaveProperty("apiKey");
    expect(result.items[0]).not.toHaveProperty("apiKeyEncrypted");
  });

  it("creates the first provider as default and stores an encrypted key", async () => {
    const tx = {
      modelProvider: {
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn(),
        create: vi.fn().mockResolvedValue(provider),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    await service.createProvider({
      name: "OpenAI Proxy",
      type: ModelProviderType.openai_compatible,
      baseUrl: "https://api.example.test",
      apiKey: "sk-live-secretabcd",
    });

    expect(tx.modelProvider.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isDefault: true,
        apiKeyEncrypted: expect.stringMatching(/^v1:/),
      }),
    });
    expect(tx.modelProvider.create.mock.calls[0][0].data.apiKeyEncrypted).not.toContain(
      "sk-live-secretabcd",
    );
  });

  it("reroutes task profiles to the provider model config when a provider becomes default", async () => {
    const defaultConfig = {
      id: "config-default",
      providerId: "provider-1",
      createdAt: new Date("2026-06-20T08:00:00Z"),
    };
    const tx = {
      modelProvider: {
        updateMany: vi.fn(),
        update: vi.fn().mockResolvedValue({ ...provider, isDefault: true }),
      },
      modelConfig: {
        findFirst: vi.fn().mockResolvedValue(defaultConfig),
      },
      modelTaskProfile: {
        updateMany: vi.fn().mockResolvedValue({ count: 12 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await service.updateProvider("provider-1", {
      isDefault: true,
    });

    expect(result.isDefault).toBe(true);
    expect(tx.modelProvider.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, id: { not: "provider-1" } },
      data: { isDefault: false },
    });
    expect(tx.modelConfig.findFirst).toHaveBeenCalledWith({
      where: {
        providerId: "provider-1",
        isEnabled: true,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(tx.modelTaskProfile.updateMany).toHaveBeenCalledWith({
      data: {
        modelConfigId: "config-default",
        isEnabled: true,
      },
    });
  });
});

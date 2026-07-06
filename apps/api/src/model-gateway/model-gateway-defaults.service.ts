import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ModelResponseFormat, ModelTaskType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";

type DefaultModelCapability =
  | "default"
  | "fast"
  | "reasoning"
  | "long_context"
  | "code";

type DefaultTaskRoute = {
  modelName: string;
  capability: DefaultModelCapability;
};

const TASK_CAPABILITY: Record<ModelTaskType, DefaultModelCapability> = {
  [ModelTaskType.intent_detection]: "fast",
  [ModelTaskType.knowledge_classification]: "fast",
  [ModelTaskType.requirement_analysis]: "reasoning",
  [ModelTaskType.conversation_planning]: "reasoning",
  [ModelTaskType.conversation_design]: "reasoning",
  [ModelTaskType.prd_generation]: "reasoning",
  [ModelTaskType.prototype_design]: "reasoning",
  [ModelTaskType.prototype_code_generation]: "code",
  [ModelTaskType.qa_check]: "reasoning",
  [ModelTaskType.knowledge_extraction]: "long_context",
  [ModelTaskType.general_chat]: "fast",
};

const CAPABILITY_MODEL_ENV: Record<DefaultModelCapability, string | undefined> = {
  default: "DEFAULT_MODEL_NAME",
  fast: "DEFAULT_MODEL_FAST_NAME",
  reasoning: "DEFAULT_MODEL_REASONING_NAME",
  long_context: "DEFAULT_MODEL_LONG_CONTEXT_NAME",
  code: "DEFAULT_MODEL_CODE_NAME",
};

@Injectable()
export class ModelGatewayDefaultsService implements OnModuleInit {
  private readonly logger = new Logger(ModelGatewayDefaultsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: ApiKeyEncryptionService,
  ) {}

  async onModuleInit() {
    const baseUrl = process.env.DEFAULT_MODEL_BASE_URL?.trim();
    const apiKey = process.env.DEFAULT_MODEL_API_KEY?.trim();
    const defaultModelName = this.readEnv("DEFAULT_MODEL_NAME");
    const taskRoutes = this.resolveTaskRoutes(defaultModelName);
    const providerName = process.env.DEFAULT_MODEL_PROVIDER_NAME?.trim() || "datatoken";

    if (!baseUrl || !apiKey || taskRoutes.size === 0) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.modelProvider.updateMany({
        where: { isDefault: true, name: { not: providerName } },
        data: { isDefault: false },
      });

      const existingProvider = await tx.modelProvider.findFirst({
        where: { name: providerName },
      });

      const provider = existingProvider
        ? await tx.modelProvider.update({
            where: { id: existingProvider.id },
            data: {
              baseUrl,
              apiKeyEncrypted: this.encryption.encrypt(apiKey),
              timeoutMs: 120000,
              isDefault: true,
              isEnabled: true,
            },
          })
        : await tx.modelProvider.create({
            data: {
              name: providerName,
              baseUrl,
              apiKeyEncrypted: this.encryption.encrypt(apiKey),
              timeoutMs: 120000,
              isDefault: true,
              isEnabled: true,
            },
          });

      const modelConfigsByName = new Map<string, { id: string }>();
      const modelCapabilities = this.uniqueModelCapabilities(taskRoutes);

      for (const [modelName, capability] of modelCapabilities) {
        const existingConfig = await tx.modelConfig.findFirst({
          where: { providerId: provider.id, modelName },
        });

        const modelConfig = existingConfig
          ? await tx.modelConfig.update({
              where: { id: existingConfig.id },
              data: this.defaultModelConfigData(provider.id, modelName, capability),
            })
          : await tx.modelConfig.create({
              data: this.defaultModelConfigData(provider.id, modelName, capability),
            });

        modelConfigsByName.set(modelName, modelConfig);
      }

      for (const [taskType, route] of taskRoutes) {
        const modelConfig = modelConfigsByName.get(route.modelName);
        if (!modelConfig) continue;

        await tx.modelTaskProfile.upsert({
          where: { taskType },
          create: {
            taskType,
            modelConfigId: modelConfig.id,
            temperature: this.temperatureFor(taskType),
            maxTokens: this.maxTokensFor(taskType),
            responseFormat: this.responseFormatFor(taskType),
            retryCount: 1,
            timeoutMs: 120000,
            isEnabled: true,
          },
          update: {
            modelConfigId: modelConfig.id,
            temperature: this.temperatureFor(taskType),
            maxTokens: this.maxTokensFor(taskType),
            responseFormat: this.responseFormatFor(taskType),
            retryCount: 1,
            timeoutMs: 120000,
            isEnabled: true,
          },
        });
      }

      if (this.keepOnlyDefaultProvider()) {
        await tx.modelConfig.updateMany({
          where: { providerId: { not: provider.id } },
          data: { isEnabled: false },
        });
        await tx.modelProvider.updateMany({
          where: { id: { not: provider.id } },
          data: { isDefault: false, isEnabled: false },
        });
      }
    });

    this.logger.log(
      `默认模型配置已就绪：${providerName} / ${Array.from(this.uniqueModelCapabilities(taskRoutes).keys()).join(", ")}`,
    );
  }

  private defaultModelConfigData(
    providerId: string,
    modelName: string,
    capability: DefaultModelCapability,
  ): Prisma.ModelConfigUncheckedCreateInput {
    const defaults = this.capabilityDefaults(capability);

    return {
      providerId,
      displayName: modelName,
      modelName,
      contextWindow: defaults.contextWindow,
      maxOutputTokens: defaults.maxOutputTokens,
      supportsStreaming: defaults.supportsStreaming,
      supportsJsonMode: defaults.supportsJsonMode,
      supportsMultimodal: defaults.supportsMultimodal,
      defaultTemperature: defaults.defaultTemperature,
      defaultMaxTokens: defaults.defaultMaxTokens,
      isEnabled: true,
    };
  }

  private responseFormatFor(taskType: ModelTaskType) {
    return taskType === ModelTaskType.general_chat ? ModelResponseFormat.text : ModelResponseFormat.json;
  }

  private temperatureFor(taskType: ModelTaskType) {
    return taskType === ModelTaskType.general_chat ? 0.4 : 0.2;
  }

  private maxTokensFor(taskType: ModelTaskType) {
    if (taskType === ModelTaskType.prototype_code_generation) return 8192;
    if (taskType === ModelTaskType.prd_generation) return 6000;
    return 4096;
  }

  private keepOnlyDefaultProvider() {
    const value = process.env.MODEL_GATEWAY_KEEP_ONLY_DEFAULT_PROVIDER?.trim().toLowerCase();
    return ["1", "true", "yes", "on"].includes(value ?? "");
  }

  private resolveTaskRoutes(defaultModelName?: string) {
    const routes = new Map<ModelTaskType, DefaultTaskRoute>();

    for (const taskType of Object.values(ModelTaskType)) {
      const capability = TASK_CAPABILITY[taskType] ?? "default";
      const taskModelName = this.readEnv(this.taskModelEnvName(taskType));
      const capabilityModelName = this.readEnv(CAPABILITY_MODEL_ENV[capability]);
      const modelName = taskModelName ?? capabilityModelName ?? defaultModelName;

      if (!modelName) continue;

      routes.set(taskType, {
        modelName,
        capability: taskModelName || capabilityModelName ? capability : "default",
      });
    }

    return routes;
  }

  private uniqueModelCapabilities(routes: Map<ModelTaskType, DefaultTaskRoute>) {
    const modelCapabilities = new Map<string, DefaultModelCapability>();

    for (const route of routes.values()) {
      const current = modelCapabilities.get(route.modelName);
      modelCapabilities.set(
        route.modelName,
        current ? this.mergeCapability(current, route.capability) : route.capability,
      );
    }

    return modelCapabilities;
  }

  private mergeCapability(
    current: DefaultModelCapability,
    next: DefaultModelCapability,
  ): DefaultModelCapability {
    const rank: Record<DefaultModelCapability, number> = {
      default: 0,
      fast: 1,
      reasoning: 2,
      long_context: 3,
      code: 4,
    };

    return rank[next] > rank[current] ? next : current;
  }

  private capabilityDefaults(capability: DefaultModelCapability) {
    switch (capability) {
      case "fast":
        return {
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsMultimodal: false,
          defaultTemperature: 0.2,
          defaultMaxTokens: 2048,
        };
      case "reasoning":
        return {
          contextWindow: 200000,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsMultimodal: false,
          defaultTemperature: 0.2,
          defaultMaxTokens: 4096,
        };
      case "long_context":
        return {
          contextWindow: 1000000,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsMultimodal: false,
          defaultTemperature: 0.2,
          defaultMaxTokens: 4096,
        };
      case "code":
        return {
          contextWindow: 200000,
          maxOutputTokens: 16000,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsMultimodal: false,
          defaultTemperature: 0.15,
          defaultMaxTokens: 8192,
        };
      case "default":
      default:
        return {
          contextWindow: 128000,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsJsonMode: false,
          supportsMultimodal: false,
          defaultTemperature: 0.2,
          defaultMaxTokens: 4096,
        };
    }
  }

  private taskModelEnvName(taskType: ModelTaskType) {
    return `DEFAULT_MODEL_TASK_${taskType.toUpperCase()}_NAME`;
  }

  private readEnv(name?: string) {
    if (!name) return undefined;
    const value = process.env[name]?.trim();
    return value || undefined;
  }
}

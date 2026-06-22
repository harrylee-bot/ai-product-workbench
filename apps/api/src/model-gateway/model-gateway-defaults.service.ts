import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ModelResponseFormat, ModelTaskType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";

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
    const modelName = process.env.DEFAULT_MODEL_NAME?.trim();
    const providerName = process.env.DEFAULT_MODEL_PROVIDER_NAME?.trim() || "DataToken 默认供应商";

    if (!baseUrl || !apiKey || !modelName) return;

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

      const existingConfig = await tx.modelConfig.findFirst({
        where: { providerId: provider.id, modelName },
      });

      const modelConfig = existingConfig
        ? await tx.modelConfig.update({
            where: { id: existingConfig.id },
            data: this.defaultModelConfigData(provider.id, modelName),
          })
        : await tx.modelConfig.create({
            data: this.defaultModelConfigData(provider.id, modelName),
          });

      for (const taskType of Object.values(ModelTaskType)) {
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
    });

    this.logger.log(`默认模型配置已就绪：${providerName} / ${modelName}`);
  }

  private defaultModelConfigData(providerId: string, modelName: string): Prisma.ModelConfigUncheckedCreateInput {
    return {
      providerId,
      displayName: modelName,
      modelName,
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsMultimodal: false,
      defaultTemperature: 0.2,
      defaultMaxTokens: 4096,
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
}

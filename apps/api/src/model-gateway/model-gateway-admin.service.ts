import { BadRequestException, Injectable } from "@nestjs/common";
import {
  ModelConfig,
  ModelProvider,
  ModelProviderType,
  ModelTaskProfile,
  ModelTaskType,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";
import type {
  CreateModelConfigDto,
  CreateModelProviderDto,
  ListModelCallLogsQueryDto,
  UpdateModelConfigDto,
  UpdateModelProviderDto,
  UpsertModelTaskProfileDto,
} from "./dto";

@Injectable()
export class ModelGatewayAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: ApiKeyEncryptionService,
  ) {}

  async listProviders() {
    const items = await this.prisma.modelProvider.findMany({
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    });

    return { items: items.map((provider) => this.toProviderItem(provider)) };
  }

  async createProvider(dto: CreateModelProviderDto) {
    return this.prisma.$transaction(async (tx) => {
      const shouldBeDefault = Boolean(dto.isDefault) || (await tx.modelProvider.count()) === 0;
      if (shouldBeDefault) {
        await tx.modelProvider.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }

      const provider = await tx.modelProvider.create({
        data: {
          name: dto.name.trim(),
          type: dto.type ?? ModelProviderType.openai_compatible,
          baseUrl: dto.baseUrl.trim(),
          apiKeyEncrypted: this.encryption.encrypt(dto.apiKey.trim()),
          defaultHeaders: this.normalizeHeaders(dto.defaultHeaders),
          timeoutMs: dto.timeoutMs,
          isDefault: shouldBeDefault,
        },
      });

      return this.toProviderItem(provider);
    });
  }

  async updateProvider(providerId: string, dto: UpdateModelProviderDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.modelProvider.updateMany({
          where: { isDefault: true, id: { not: providerId } },
          data: { isDefault: false },
        });
      }

      try {
        const provider = await tx.modelProvider.update({
          where: { id: providerId },
          data: {
            name: dto.name?.trim(),
            baseUrl: dto.baseUrl?.trim(),
            apiKeyEncrypted: dto.apiKey
              ? this.encryption.encrypt(dto.apiKey.trim())
              : undefined,
            defaultHeaders:
              dto.defaultHeaders === undefined
                ? undefined
                : this.normalizeHeaders(dto.defaultHeaders),
            timeoutMs: dto.timeoutMs,
            isDefault: dto.isDefault,
          },
        });

        return this.toProviderItem(provider);
      } catch (error) {
        this.throwNotFound(error, "模型供应商不存在");
        throw error;
      }
    });
  }

  async enableProvider(providerId: string) {
    await this.updateProviderStatus(providerId, true);
    return { success: true };
  }

  async disableProvider(providerId: string) {
    await this.updateProviderStatus(providerId, false);
    return { success: true };
  }

  async listModelConfigs() {
    const items = await this.prisma.modelConfig.findMany({
      include: { provider: true },
      orderBy: { createdAt: "desc" },
    });

    return { items: items.map((config) => this.toModelConfigItem(config)) };
  }

  async createModelConfig(dto: CreateModelConfigDto) {
    await this.ensureProviderExists(dto.providerId);

    const config = await this.prisma.modelConfig.create({
      data: {
        providerId: dto.providerId,
        displayName: dto.displayName.trim(),
        modelName: dto.modelName.trim(),
        contextWindow: dto.contextWindow,
        maxOutputTokens: dto.maxOutputTokens,
        supportsStreaming: dto.supportsStreaming,
        supportsJsonMode: dto.supportsJsonMode,
        defaultTemperature: dto.defaultTemperature,
        defaultMaxTokens: dto.defaultMaxTokens,
      },
      include: { provider: true },
    });

    return this.toModelConfigItem(config);
  }

  async updateModelConfig(modelConfigId: string, dto: UpdateModelConfigDto) {
    if (dto.providerId) await this.ensureProviderExists(dto.providerId);

    try {
      const config = await this.prisma.modelConfig.update({
        where: { id: modelConfigId },
        data: {
          providerId: dto.providerId,
          displayName: dto.displayName?.trim(),
          modelName: dto.modelName?.trim(),
          contextWindow: dto.contextWindow,
          maxOutputTokens: dto.maxOutputTokens,
          supportsStreaming: dto.supportsStreaming,
          supportsJsonMode: dto.supportsJsonMode,
          defaultTemperature: dto.defaultTemperature,
          defaultMaxTokens: dto.defaultMaxTokens,
          isEnabled: dto.isEnabled,
        },
        include: { provider: true },
      });

      return this.toModelConfigItem(config);
    } catch (error) {
      this.throwNotFound(error, "模型配置不存在");
      throw error;
    }
  }

  async listTaskProfiles() {
    const items = await this.prisma.modelTaskProfile.findMany({
      include: {
        modelConfig: {
          include: { provider: true },
        },
      },
      orderBy: { taskType: "asc" },
    });

    return { items: items.map((profile) => this.toTaskProfileItem(profile)) };
  }

  async upsertTaskProfile(taskType: string, dto: UpsertModelTaskProfileDto) {
    if (!this.isTaskType(taskType)) {
      throw new BadRequestException("任务类型不正确");
    }

    await this.ensureModelConfigExists(dto.modelConfigId);

    const profile = await this.prisma.modelTaskProfile.upsert({
      where: { taskType },
      create: {
        taskType,
        modelConfigId: dto.modelConfigId,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        responseFormat: dto.responseFormat,
        retryCount: dto.retryCount,
        timeoutMs: dto.timeoutMs,
        isEnabled: dto.isEnabled,
      },
      update: {
        modelConfigId: dto.modelConfigId,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        responseFormat: dto.responseFormat,
        retryCount: dto.retryCount,
        timeoutMs: dto.timeoutMs,
        isEnabled: dto.isEnabled,
      },
      include: {
        modelConfig: {
          include: { provider: true },
        },
      },
    });

    return this.toTaskProfileItem(profile);
  }

  async listCallLogs(query: ListModelCallLogsQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
    const where: Prisma.ModelCallLogWhereInput = {
      taskType: query.taskType,
      agentName: query.agentName,
      status: query.status,
      runId: query.runId,
      traceId: query.traceId,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.modelCallLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.modelCallLog.count({ where }),
    ]);

    return {
      items: items.map((log) => ({
        id: log.id,
        traceId: log.traceId,
        runId: log.runId,
        agentName: log.agentName,
        taskType: log.taskType,
        providerId: log.providerId,
        modelConfigId: log.modelConfigId,
        modelName: log.modelName,
        status: log.status,
        inputSummary: log.inputSummary,
        outputSummary: log.outputSummary,
        promptTokens: log.promptTokens,
        completionTokens: log.completionTokens,
        totalTokens: log.totalTokens,
        durationMs: log.durationMs,
        errorCode: log.errorCode,
        errorMessage: log.errorMessage,
        createdAt: log.createdAt.toISOString(),
        completedAt: log.completedAt?.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  private async updateProviderStatus(providerId: string, isEnabled: boolean) {
    try {
      await this.prisma.modelProvider.update({
        where: { id: providerId },
        data: { isEnabled },
      });
    } catch (error) {
      this.throwNotFound(error, "模型供应商不存在");
      throw error;
    }
  }

  private async ensureProviderExists(providerId: string) {
    const provider = await this.prisma.modelProvider.findUnique({ where: { id: providerId } });
    if (!provider) throw new BadRequestException("模型供应商不存在");
  }

  private async ensureModelConfigExists(modelConfigId: string) {
    const config = await this.prisma.modelConfig.findUnique({ where: { id: modelConfigId } });
    if (!config) throw new BadRequestException("模型配置不存在");
  }

  private toProviderItem(provider: ModelProvider) {
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      defaultHeaders: this.maskHeaders(provider.defaultHeaders),
      timeoutMs: provider.timeoutMs,
      isDefault: provider.isDefault,
      isEnabled: provider.isEnabled,
      hasApiKey: Boolean(provider.apiKeyEncrypted),
      apiKeyMasked: this.safeMask(provider.apiKeyEncrypted),
      createdAt: provider.createdAt.toISOString(),
      updatedAt: provider.updatedAt.toISOString(),
    };
  }

  private toModelConfigItem(
    config: ModelConfig & { provider?: Pick<ModelProvider, "id" | "name" | "isEnabled"> },
  ) {
    return {
      id: config.id,
      providerId: config.providerId,
      providerName: config.provider?.name,
      providerEnabled: config.provider?.isEnabled,
      displayName: config.displayName,
      modelName: config.modelName,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
      supportsStreaming: config.supportsStreaming,
      supportsJsonMode: config.supportsJsonMode,
      defaultTemperature: config.defaultTemperature,
      defaultMaxTokens: config.defaultMaxTokens,
      isEnabled: config.isEnabled,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  private toTaskProfileItem(
    profile: ModelTaskProfile & {
      modelConfig?: ModelConfig & { provider?: Pick<ModelProvider, "id" | "name" | "isEnabled"> };
    },
  ) {
    return {
      id: profile.id,
      taskType: profile.taskType,
      modelConfigId: profile.modelConfigId,
      modelName: profile.modelConfig?.modelName,
      providerId: profile.modelConfig?.providerId,
      providerName: profile.modelConfig?.provider?.name,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      responseFormat: profile.responseFormat,
      retryCount: profile.retryCount,
      timeoutMs: profile.timeoutMs,
      isEnabled: profile.isEnabled,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  private normalizeHeaders(headers?: Record<string, string>): Prisma.InputJsonValue | undefined {
    if (!headers) return undefined;

    const normalized = Object.fromEntries(
      Object.entries(headers)
        .filter(([, value]) => typeof value === "string")
        .filter(([key]) => key.toLowerCase() !== "authorization")
        .map(([key, value]) => [key.trim(), value.trim()]),
    );

    return Object.keys(normalized).length ? normalized : undefined;
  }

  private maskHeaders(headers: Prisma.JsonValue | null) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;

    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        this.isSensitiveHeader(key) ? "****" : value,
      ]),
    );
  }

  private isSensitiveHeader(key: string) {
    return ["authorization", "api-key", "x-api-key", "apikey"].includes(key.toLowerCase());
  }

  private safeMask(cipherText: string) {
    try {
      return this.encryption.maskEncrypted(cipherText);
    } catch {
      return "****";
    }
  }

  private isTaskType(value: string): value is ModelTaskType {
    return Object.values(ModelTaskType).includes(value as ModelTaskType);
  }

  private throwNotFound(error: unknown, message: string) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new BadRequestException(message);
    }
  }
}

import { BadRequestException, Injectable } from "@nestjs/common";
import { ModelTaskType } from "@prisma/client";
import { resolveSelectedRuntimeModelName } from "../common/runtime-model-config";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class RuntimeModelPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: {
    selectedModelId?: string;
    taskType: ModelTaskType;
  }) {
    const selectedModelName = resolveSelectedRuntimeModelName(input.selectedModelId);
    if (input.selectedModelId && !selectedModelName) {
      throw new BadRequestException("RUNTIME_MODEL_NOT_ALLOWED");
    }

    if (selectedModelName) {
      const matchingModels = await this.prisma.modelConfig.findMany({
        where: { modelName: selectedModelName },
        include: { provider: true },
      });
      if (
        matchingModels.length > 0 &&
        !matchingModels.some((model) => model.isEnabled && model.provider.isEnabled)
      ) {
        throw new BadRequestException("RUNTIME_MODEL_DISABLED");
      }
      return selectedModelName;
    }

    const profile = await this.prisma.modelTaskProfile.findUnique({
      where: { taskType: input.taskType },
      include: { modelConfig: { include: { provider: true } } },
    });
    if (!profile) return undefined;
    if (!profile.isEnabled || !profile.modelConfig.isEnabled || !profile.modelConfig.provider.isEnabled) {
      throw new BadRequestException("RUNTIME_MODEL_PROFILE_DISABLED");
    }
    return profile.modelConfig.modelName;
  }
}

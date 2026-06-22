import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Query, UseGuards } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import { CurrentUser } from "../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../modules/auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { ApplyEvolutionDto, TraceEvolutionDto } from "./evolution.dto";
import { FusionEvolutionService } from "./evolution.service";

@Controller("evolution")
@UseGuards(JwtAuthGuard)
export class FusionEvolutionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evolution: FusionEvolutionService,
  ) {}

  @Post("trace")
  async trace(@CurrentUser() user: Phase1User, @Body() dto: TraceEvolutionDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const metrics = dto.metrics ?? {
      qaPassed: true,
      userSatisfaction: 0.72,
      executionTime: 0,
    };
    return this.evolution.trace({
      projectId: dto.projectId,
      sourceType: "api",
      userInput: dto.input,
      decisionPlan: dto.decisionPlan,
      outcome: dto.outcome ?? this.evolution.resolveOutcome(metrics),
      metrics,
      createdBy: user.id,
    });
  }

  @Post("apply")
  async apply(@CurrentUser() user: Phase1User, @Body() dto: ApplyEvolutionDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const metrics = dto.metrics ?? {
      qaPassed: true,
      userSatisfaction: 0.72,
      executionTime: 0,
    };
    return this.evolution.apply({
      projectId: dto.projectId,
      traceId: dto.traceId,
      strategyId: dto.strategyId,
      outcome: dto.outcome ?? this.evolution.resolveOutcome(metrics),
      metrics,
      createdBy: user.id,
    });
  }

  @Get("policy")
  async policy(@CurrentUser() user: Phase1User, @Query("projectId") projectId: string) {
    await this.assertProjectAccess(user, projectId);
    return this.evolution.policy(projectId);
  }

  private async assertProjectAccess(user: Phase1User, projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("无权访问该项目");
    }
  }
}

import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import { CurrentUser } from "../../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../../modules/auth/auth.types";
import { PrismaService } from "../../prisma/prisma.service";
import { MutationEngine } from "./mutation.engine";
import { SelfGenerationEngine } from "./self-generation.engine";
import { SystemGraphService } from "./system.graph.service";
import { SystemPreviewService } from "./system.preview.service";
import { ApplySystemMutationDto, PreviewSystemMutationDto, ProposeSystemMutationDto } from "./system-mutation.dto";

@Controller("system")
@UseGuards(JwtAuthGuard)
export class SystemMutationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly selfGeneration: SelfGenerationEngine,
    private readonly previews: SystemPreviewService,
    private readonly mutations: MutationEngine,
    private readonly graphs: SystemGraphService,
  ) {}

  @Get("graph")
  async graph(@CurrentUser() user: Phase1User, @Query("projectId") projectId: string) {
    await this.assertProjectAccess(user, projectId);
    return this.graphs.getGraph(projectId);
  }

  @Post("mutation/propose")
  async propose(@CurrentUser() user: Phase1User, @Body() dto: ProposeSystemMutationDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.selfGeneration.proposeManual({
      projectId: dto.projectId,
      createdBy: user.id,
      instruction: dto.instruction,
    });
  }

  @Post("preview")
  async preview(@CurrentUser() user: Phase1User, @Body() dto: PreviewSystemMutationDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.previews.createPreview({
      projectId: dto.projectId,
      createdBy: user.id,
      mutations: dto.mutations,
    });
  }

  @Post("mutation/apply")
  async apply(@CurrentUser() user: Phase1User, @Body() dto: ApplySystemMutationDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.mutations.applyProposal({
      projectId: dto.projectId,
      proposalId: dto.proposalId,
      confirm: dto.confirm,
      createdBy: user.id,
    });
  }

  @Post("mutation/logs/:logId/rollback")
  async rollback(
    @CurrentUser() user: Phase1User,
    @Param("logId") logId: string,
    @Body() dto: { projectId: string },
  ) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.mutations.rollback({
      projectId: dto.projectId,
      logId,
      createdBy: user.id,
    });
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

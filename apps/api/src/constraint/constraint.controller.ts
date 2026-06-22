import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Query, UseGuards } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import { CurrentUser } from "../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../modules/auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { BuildConstraintDto } from "./constraint.dto";
import { ConstraintService } from "./constraint.service";

@Controller("constraint")
@UseGuards(JwtAuthGuard)
export class ConstraintController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly constraints: ConstraintService,
  ) {}

  @Post("build")
  async build(@CurrentUser() user: Phase1User, @Body() dto: BuildConstraintDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.constraints.build({
      projectId: dto.projectId,
      userInput: dto.input,
      createdBy: user.id,
    });
  }

  @Get("context")
  async context(@CurrentUser() user: Phase1User, @Query("projectId") projectId: string) {
    await this.assertProjectAccess(user, projectId);
    return this.constraints.context(projectId);
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

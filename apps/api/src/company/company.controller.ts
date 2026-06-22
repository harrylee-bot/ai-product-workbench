import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Query, UseGuards } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import { CurrentUser } from "../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../modules/auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CompanyInputDto, CompanyInitiativeDto } from "./company.dto";
import { CompanyRuntimeService } from "./company-runtime.service";

@Controller("company")
@UseGuards(JwtAuthGuard)
export class CompanyController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: CompanyRuntimeService,
  ) {}

  @Get("dashboard")
  async dashboard(@CurrentUser() user: Phase1User, @Query("projectId") projectId: string) {
    await this.assertProjectAccess(user, projectId);
    return this.runtime.dashboard(projectId);
  }

  @Post("ceo/decide")
  async decide(@CurrentUser() user: Phase1User, @Body() dto: CompanyInputDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.decide({
      projectId: dto.projectId,
      marketSignal: dto.input,
      createdBy: user.id,
    });
  }

  @Post("product/create")
  async createProduct(@CurrentUser() user: Phase1User, @Body() dto: CompanyInputDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.createProduct({
      projectId: dto.projectId,
      marketSignal: dto.input,
      createdBy: user.id,
    });
  }

  @Post("engineering/build")
  async buildEngineering(@CurrentUser() user: Phase1User, @Body() dto: CompanyInitiativeDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.buildEngineering({
      projectId: dto.projectId,
      initiativeId: dto.initiativeId,
      createdBy: user.id,
    });
  }

  @Post("design/generate")
  async generateDesign(@CurrentUser() user: Phase1User, @Body() dto: CompanyInitiativeDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.generateDesign({
      projectId: dto.projectId,
      initiativeId: dto.initiativeId,
      createdBy: user.id,
    });
  }

  @Post("qa/run")
  async runQA(@CurrentUser() user: Phase1User, @Body() dto: CompanyInitiativeDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.runQA({
      projectId: dto.projectId,
      initiativeId: dto.initiativeId,
      createdBy: user.id,
    });
  }

  @Post("growth/optimize")
  async optimizeGrowth(@CurrentUser() user: Phase1User, @Body() dto: CompanyInitiativeDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.optimizeGrowth({
      projectId: dto.projectId,
      initiativeId: dto.initiativeId,
      createdBy: user.id,
    });
  }

  @Post("evolution/apply")
  async applyEvolution(@CurrentUser() user: Phase1User, @Body() dto: CompanyInitiativeDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.runtime.applyEvolution({
      projectId: dto.projectId,
      initiativeId: dto.initiativeId,
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

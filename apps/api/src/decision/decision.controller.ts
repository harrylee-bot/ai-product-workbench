import { Body, Controller, ForbiddenException, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import { ConstraintService } from "../constraint/constraint.service";
import { CurrentUser } from "../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../modules/auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { GenerateDecisionDto, SelectDecisionDto } from "./decision.dto";
import { FusionDecisionService } from "./decision.service";

@Controller("decision")
@UseGuards(JwtAuthGuard)
export class FusionDecisionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly constraints: ConstraintService,
    private readonly decisions: FusionDecisionService,
  ) {}

  @Post("generate")
  async generate(@CurrentUser() user: Phase1User, @Body() dto: GenerateDecisionDto) {
    await this.assertProjectAccess(user, dto.projectId);
    const context =
      dto.constraintContext ??
      (await this.constraints.build({
        projectId: dto.projectId,
        userInput: dto.input,
        createdBy: user.id,
      }));
    return this.decisions.generate({
      projectId: dto.projectId,
      userInput: dto.input,
      intent: "new_requirement",
      constraintContext: context,
      createdBy: user.id,
    });
  }

  @Post("select")
  async select(@CurrentUser() user: Phase1User, @Body() dto: SelectDecisionDto) {
    await this.assertProjectAccess(user, dto.projectId);
    return this.decisions.select(dto.decisionPlan);
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

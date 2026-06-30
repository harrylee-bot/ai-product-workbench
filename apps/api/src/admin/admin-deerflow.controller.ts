import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import { IsBoolean } from "class-validator";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { AdminDeerflowService } from "./admin-deerflow.service";

class UpdateDeerflowSkillDto {
  @IsBoolean()
  enabled!: boolean;
}

@Controller("admin/deerflow")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class AdminDeerflowController {
  constructor(private readonly deerflow: AdminDeerflowService) {}

  @Get("skills")
  listSkills() {
    return this.deerflow.listSkills();
  }

  @Put("skills/:skillName")
  updateSkill(
    @Param("skillName") skillName: string,
    @Body() dto: UpdateDeerflowSkillDto,
  ) {
    return this.deerflow.updateSkill(skillName, dto.enabled);
  }
}

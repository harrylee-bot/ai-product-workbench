import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { Phase1User } from "../auth/auth.types";
import { CreateProjectDto, ListProjectsQueryDto, UpdateProjectDto } from "./dto";
import { ProjectService } from "./project.service";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Post()
  create(@CurrentUser() user: Phase1User, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: Phase1User, @Query() query: ListProjectsQueryDto) {
    return this.projects.list(user, query);
  }

  @Get(":projectId")
  get(@CurrentUser() user: Phase1User, @Param("projectId") projectId: string) {
    return this.projects.get(user, projectId);
  }

  @Patch(":projectId")
  update(
    @CurrentUser() user: Phase1User,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(user, projectId, dto);
  }

  @Delete(":projectId")
  delete(@CurrentUser() user: Phase1User, @Param("projectId") projectId: string) {
    return this.projects.delete(user, projectId);
  }
}

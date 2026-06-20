import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import {
  CreateConversationDto,
  CreateProjectDto,
  ListProjectsQueryDto,
  UpdateProjectDto,
} from "./dto";
import { ProjectService } from "./project.service";

@Controller("projects")
@UseGuards(JwtAuthGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  createProject(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateProjectDto) {
    return this.projectService.createProject(user, dto);
  }

  @Get()
  listProjects(@CurrentUser() user: AuthenticatedUser, @Query() query: ListProjectsQueryDto) {
    return this.projectService.listProjects(user, query);
  }

  @Get(":projectId")
  getProject(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.projectService.getProject(user, projectId);
  }

  @Patch(":projectId")
  updateProject(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.updateProject(user, projectId, dto);
  }

  @Post(":projectId/archive")
  archiveProject(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.projectService.archiveProject(user, projectId);
  }

  @Post(":projectId/restore")
  restoreProject(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.projectService.restoreProject(user, projectId);
  }

  @Delete(":projectId")
  deleteProject(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.projectService.deleteProject(user, projectId);
  }

  @Get(":projectId/conversations")
  listConversations(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
  ) {
    return this.projectService.listConversations(user, projectId);
  }

  @Post(":projectId/conversations")
  createConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.projectService.createConversation(user, projectId, dto);
  }

  @Post(":projectId/conversations/default")
  ensureDefaultConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
  ) {
    return this.projectService.ensureDefaultConversation(user, projectId);
  }
}

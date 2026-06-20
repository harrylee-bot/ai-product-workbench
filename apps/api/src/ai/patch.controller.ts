import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ConfirmPatchDto, CreatePatchDto, ListPatchRecordsQueryDto } from "./patch.dto";
import { PatchService } from "./patch.service";

@Controller("projects/:projectId/patches")
@UseGuards(JwtAuthGuard)
export class ProjectPatchController {
  constructor(private readonly patchService: PatchService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: CreatePatchDto,
  ) {
    return this.patchService.createPatchForUser(user, projectId, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Query() query: ListPatchRecordsQueryDto,
  ) {
    return this.patchService.listForProject(user, projectId, query);
  }
}

@Controller("patches")
@UseGuards(JwtAuthGuard)
export class PatchResourceController {
  constructor(private readonly patchService: PatchService) {}

  @Get(":patchId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("patchId") patchId: string) {
    return this.patchService.getPatchForUser(user, patchId);
  }

  @Post(":patchId/cancel")
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("patchId") patchId: string) {
    return this.patchService.cancelForUser(user, patchId);
  }

  @Post(":patchId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("patchId") patchId: string,
    @Body() dto: ConfirmPatchDto,
  ) {
    return this.patchService.confirmForUser(user, patchId, dto.userConfirmation);
  }
}

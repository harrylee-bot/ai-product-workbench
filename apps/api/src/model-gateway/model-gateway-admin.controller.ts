import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { CurrentRequestMeta } from "../common/request-meta.decorator";
import {
  CreateModelConfigDto,
  CreateModelProviderDto,
  ListModelCallLogsQueryDto,
  UpdateModelConfigDto,
  UpdateModelProviderDto,
  UpsertModelTaskProfileDto,
} from "./dto";
import { ModelGatewayAdminService } from "./model-gateway-admin.service";

@Controller("admin")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class ModelGatewayAdminController {
  constructor(private readonly adminService: ModelGatewayAdminService) {}

  @Get("model-providers")
  listProviders() {
    return this.adminService.listProviders();
  }

  @Post("model-providers")
  createProvider(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Body() dto: CreateModelProviderDto,
  ) {
    return this.adminService.createProvider(dto, user, meta);
  }

  @Patch("model-providers/:providerId")
  updateProvider(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("providerId") providerId: string,
    @Body() dto: UpdateModelProviderDto,
  ) {
    return this.adminService.updateProvider(providerId, dto, user, meta);
  }

  @Post("model-providers/:providerId/enable")
  enableProvider(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("providerId") providerId: string,
  ) {
    return this.adminService.enableProvider(providerId, user, meta);
  }

  @Post("model-providers/:providerId/disable")
  disableProvider(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("providerId") providerId: string,
  ) {
    return this.adminService.disableProvider(providerId, user, meta);
  }

  @Get("model-configs")
  listModelConfigs() {
    return this.adminService.listModelConfigs();
  }

  @Post("model-configs")
  createModelConfig(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Body() dto: CreateModelConfigDto,
  ) {
    return this.adminService.createModelConfig(dto, user, meta);
  }

  @Patch("model-configs/:modelConfigId")
  updateModelConfig(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("modelConfigId") modelConfigId: string,
    @Body() dto: UpdateModelConfigDto,
  ) {
    return this.adminService.updateModelConfig(modelConfigId, dto, user, meta);
  }

  @Get("model-task-profiles")
  listTaskProfiles() {
    return this.adminService.listTaskProfiles();
  }

  @Put("model-task-profiles/:taskType")
  upsertTaskProfile(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("taskType") taskType: string,
    @Body() dto: UpsertModelTaskProfileDto,
  ) {
    return this.adminService.upsertTaskProfile(taskType, dto, user, meta);
  }

  @Get("model-call-logs")
  listCallLogs(@Query() query: ListModelCallLogsQueryDto) {
    return this.adminService.listCallLogs(query);
  }
}

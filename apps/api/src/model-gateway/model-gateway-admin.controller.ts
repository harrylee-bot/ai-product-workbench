import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
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
  createProvider(@Body() dto: CreateModelProviderDto) {
    return this.adminService.createProvider(dto);
  }

  @Patch("model-providers/:providerId")
  updateProvider(@Param("providerId") providerId: string, @Body() dto: UpdateModelProviderDto) {
    return this.adminService.updateProvider(providerId, dto);
  }

  @Post("model-providers/:providerId/enable")
  enableProvider(@Param("providerId") providerId: string) {
    return this.adminService.enableProvider(providerId);
  }

  @Post("model-providers/:providerId/disable")
  disableProvider(@Param("providerId") providerId: string) {
    return this.adminService.disableProvider(providerId);
  }

  @Get("model-configs")
  listModelConfigs() {
    return this.adminService.listModelConfigs();
  }

  @Post("model-configs")
  createModelConfig(@Body() dto: CreateModelConfigDto) {
    return this.adminService.createModelConfig(dto);
  }

  @Patch("model-configs/:modelConfigId")
  updateModelConfig(
    @Param("modelConfigId") modelConfigId: string,
    @Body() dto: UpdateModelConfigDto,
  ) {
    return this.adminService.updateModelConfig(modelConfigId, dto);
  }

  @Get("model-task-profiles")
  listTaskProfiles() {
    return this.adminService.listTaskProfiles();
  }

  @Put("model-task-profiles/:taskType")
  upsertTaskProfile(
    @Param("taskType") taskType: string,
    @Body() dto: UpsertModelTaskProfileDto,
  ) {
    return this.adminService.upsertTaskProfile(taskType, dto);
  }

  @Get("model-call-logs")
  listCallLogs(@Query() query: ListModelCallLogsQueryDto) {
    return this.adminService.listCallLogs(query);
  }
}

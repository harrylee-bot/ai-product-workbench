import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { CurrentRequestMeta } from "../common/request-meta.decorator";
import { AdminUsersService } from "./admin-users.service";
import { CreateUserDto, ListUsersQueryDto, ResetPasswordDto, UpdateUserDto } from "./dto";

@Controller("admin/users")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.adminUsersService.listUsers(query);
  }

  @Post()
  createUser(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Body() dto: CreateUserDto,
  ) {
    return this.adminUsersService.createUser(dto, user, meta);
  }

  @Patch(":id")
  updateUser(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.adminUsersService.updateUser(id, dto, user, meta);
  }

  @Post(":id/disable")
  disableUser(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("id") id: string,
  ) {
    return this.adminUsersService.disableUser(id, user, meta);
  }

  @Post(":id/enable")
  enableUser(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("id") id: string,
  ) {
    return this.adminUsersService.enableUser(id, user, meta);
  }

  @Post(":id/reset-password")
  resetPassword(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("id") id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.adminUsersService.resetPassword(id, dto.password, user, meta);
  }
}

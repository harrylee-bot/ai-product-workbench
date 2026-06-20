import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
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
  createUser(@Body() dto: CreateUserDto) {
    return this.adminUsersService.createUser(dto);
  }

  @Patch(":id")
  updateUser(@Param("id") id: string, @Body() dto: UpdateUserDto) {
    return this.adminUsersService.updateUser(id, dto);
  }

  @Post(":id/disable")
  disableUser(@Param("id") id: string) {
    return this.adminUsersService.disableUser(id);
  }

  @Post(":id/enable")
  enableUser(@Param("id") id: string) {
    return this.adminUsersService.enableUser(id);
  }

  @Post(":id/reset-password")
  resetPassword(@Param("id") id: string, @Body() dto: ResetPasswordDto) {
    return this.adminUsersService.resetPassword(id, dto.password);
  }
}

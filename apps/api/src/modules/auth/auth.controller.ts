import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { CurrentUser } from "./current-user.decorator";
import { LoginDto } from "./dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { Phase1User } from "./auth.types";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: Phase1User) {
    return this.auth.me(user);
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  logout() {
    return this.auth.logout();
  }
}

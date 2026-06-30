import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { AUTH_COOKIE_NAME, authCookieOptions, clearAuthCookieOptions } from "../../common/auth-cookie";
import { CurrentUser } from "./current-user.decorator";
import { LoginDto, RegisterDto } from "./dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { Phase1User } from "./auth.types";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  // sec-3：登录接口严格限流防暴破（10 次/分钟/IP）。
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    return this.auth.login(dto).then(({ accessToken, user }) => {
      response.cookie(AUTH_COOKIE_NAME, accessToken, authCookieOptions());
      return { user };
    });
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: Phase1User) {
    return { user: this.auth.me(user) };
  }

  @Post("register")
  // sec-3：注册接口限流防刷（5 次/分钟/IP）。
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto, @Res({ passthrough: true }) response: Response) {
    return this.auth.register(dto).then(({ accessToken, user }) => {
      response.cookie(AUTH_COOKIE_NAME, accessToken, authCookieOptions());
      return { user };
    });
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions());
    return this.auth.logout();
  }
}

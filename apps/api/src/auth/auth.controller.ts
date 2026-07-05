import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { AUTH_COOKIE_NAME, authCookieOptions, clearAuthCookieOptions } from "../common/auth-cookie";
import { CurrentUser } from "./current-user.decorator";
import { LoginDto, RegisterDto } from "./dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { AuthenticatedUser } from "./auth.types";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

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
  me(@CurrentUser() user: AuthenticatedUser) {
    return { user: this.auth.me(user) };
  }

  @Get("session")
  session(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = readAuthCookie(request);
    return this.auth.session(token).then((user) => {
      if (!user && token) {
        response.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions());
      }
      return { user };
    });
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
  @HttpCode(200)
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions());
    return this.auth.logout();
  }
}

function readAuthCookie(request: Request) {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[AUTH_COOKIE_NAME] ?? null;
}

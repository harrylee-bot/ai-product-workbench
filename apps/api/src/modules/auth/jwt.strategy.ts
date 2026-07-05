import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { Strategy } from "passport-jwt";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { getJwtSecret } from "../../common/secret-config";
import { AUTH_COOKIE_NAME } from "../../common/auth-cookie";
import type { AuthJwtPayload, AuthenticatedUser } from "./auth.types";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly prisma: PrismaService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ConfigService) _configService: ConfigService,
  ) {
    super({
      jwtFromRequest: (request: Request) => readJwtCookie(request),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
    this.prisma = prisma;
  }

  async validate(payload: AuthJwtPayload): Promise<AuthenticatedUser> {
    const userId = payload.userId ?? payload.sub;
    if (!userId) throw new UnauthorizedException("未登录");

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("未登录");
    if (user.status === UserStatus.disabled) {
      throw new ForbiddenException("当前账号已被禁用，请联系管理员");
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
    };
  }
}

function readJwtCookie(request: Request) {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[AUTH_COOKIE_NAME] ?? null;
}

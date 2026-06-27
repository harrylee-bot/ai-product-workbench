import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { getJwtSecret } from "../../common/secret-config";
import type { Phase1JwtPayload, Phase1User } from "./auth.types";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly prisma: PrismaService;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(ConfigService) _configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
    });
    this.prisma = prisma;
  }

  async validate(payload: Phase1JwtPayload): Promise<Phase1User> {
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

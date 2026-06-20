import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { User, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { JwtPayload, PublicUser, RequestMeta } from "./auth.types";
import type { LoginDto } from "./dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta) {
    const account = dto.account?.trim();
    const password = dto.password;

    if (!account || !password) {
      throw new BadRequestException("请输入账号和密码");
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: account }, { email: account }],
      },
    });

    if (!user) {
      await this.writeLoginAudit({ account, success: false, failReason: "账号或密码错误", meta });
      throw new BadRequestException("账号或密码错误");
    }

    if (user.status === UserStatus.disabled) {
      await this.writeLoginAudit({
        account,
        userId: user.id,
        success: false,
        failReason: "当前账号已被禁用，请联系管理员",
        meta,
      });
      throw new ForbiddenException("当前账号已被禁用，请联系管理员");
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      await this.writeLoginAudit({
        account,
        userId: user.id,
        success: false,
        failReason: "账号或密码错误",
        meta,
      });
      throw new BadRequestException("账号或密码错误");
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.writeLoginAudit({
      account,
      userId: user.id,
      success: true,
      meta,
    });

    const payload: JwtPayload = {
      sub: user.id,
      userId: user.id,
      role: user.role,
    };

    return {
      accessToken: await this.jwtService.signAsync(payload),
      user: this.toPublicUser(updatedUser),
    };
  }

  async me(user: PublicUser) {
    return user;
  }

  async logout() {
    return { success: true };
  }

  toPublicUser(user: User): PublicUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
    };
  }

  private async writeLoginAudit(input: {
    account: string;
    userId?: string;
    success: boolean;
    failReason?: string;
    meta: RequestMeta;
  }) {
    await this.prisma.loginAuditLog.create({
      data: {
        account: input.account,
        userId: input.userId,
        success: input.success,
        failReason: input.failReason,
        ip: input.meta.ip,
        userAgent: input.meta.userAgent,
      },
    });
  }
}

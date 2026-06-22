import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { User, UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { LoginDto } from "./dto";
import type { Phase1JwtPayload, Phase1User } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const account = (dto.email ?? dto.account ?? "").trim();
    if (!account || !dto.password) throw new BadRequestException("请输入邮箱和密码");

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: account }, { username: account }],
      },
    });
    if (!user) throw new BadRequestException("账号或密码错误");
    if (user.status === UserStatus.disabled) {
      throw new ForbiddenException("当前账号已被禁用");
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new BadRequestException("账号或密码错误");

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: Phase1JwtPayload = {
      sub: user.id,
      userId: user.id,
      role: user.role,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toPublicUser(user),
    };
  }

  me(user: Phase1User) {
    return user;
  }

  logout() {
    return { success: true };
  }

  private toPublicUser(user: User): Phase1User {
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

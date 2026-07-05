import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { User, UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { LoginDto, RegisterDto } from "./dto";
import type { AuthJwtPayload, AuthenticatedUser } from "./auth.types";

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

    const payload: AuthJwtPayload = {
      sub: user.id,
      userId: user.id,
      role: user.role,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toPublicUser(user),
    };
  }

  me(user: AuthenticatedUser) {
    return user;
  }

  async session(accessToken?: string | null) {
    if (!accessToken) return null;

    try {
      const payload = await this.jwt.verifyAsync<AuthJwtPayload>(accessToken);
      const userId = payload.userId ?? payload.sub;
      if (!userId) return null;

      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== UserStatus.active) return null;

      return this.toPublicUser(user);
    } catch {
      return null;
    }
  }

  async register(dto: RegisterDto) {
    const username = dto.username.trim();
    if (!username) throw new BadRequestException("username 不能为空");

    const email = dto.email?.trim() ? dto.email.trim() : null;
    const displayName = dto.displayName?.trim() ? dto.displayName.trim() : username;

    // 唯一性冲突检查：username 必填唯一，email 选填唯一。
    const conflict = await this.prisma.user.findFirst({
      where: {
        OR: [{ username }, ...(email ? [{ email }] : [])],
      },
      select: { id: true, username: true, email: true },
    });
    if (conflict) {
      if (conflict.username === username) {
        throw new ConflictException("用户名已被占用");
      }
      throw new ConflictException("邮箱已被注册");
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        displayName,
        role: UserRole.user,
        status: UserStatus.active,
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: AuthJwtPayload = {
      sub: user.id,
      userId: user.id,
      role: user.role,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toPublicUser(user),
    };
  }

  logout() {
    return { success: true };
  }

  private toPublicUser(user: User): AuthenticatedUser {
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

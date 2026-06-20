import { BadRequestException, Injectable } from "@nestjs/common";
import bcrypt from "bcryptjs";
import { Prisma, User, UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from "./dto";

type UserItem = {
  id: string;
  username: string;
  email?: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(query: ListUsersQueryDto) {
    const page = Math.max(Number(query.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 10), 1), 100);
    const where: Prisma.UserWhereInput = {};
    const keyword = query.keyword?.trim();

    if (keyword) {
      where.OR = [
        { username: { contains: keyword, mode: "insensitive" } },
        { email: { contains: keyword, mode: "insensitive" } },
      ];
    }

    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => this.toUserItem(user)),
      total,
      page,
      pageSize,
    };
  }

  async createUser(dto: CreateUserDto) {
    try {
      const passwordHash = await bcrypt.hash(dto.password, 12);
      const user = await this.prisma.user.create({
        data: {
          username: dto.username.trim(),
          email: this.normalizeEmail(dto.email),
          displayName: dto.displayName.trim(),
          passwordHash,
          role: dto.role ?? UserRole.user,
          status: dto.status ?? UserStatus.active,
        },
      });

      return this.toUserItem(user);
    } catch (error) {
      this.throwUniqueError(error);
      throw error;
    }
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: {
          email: dto.email === undefined ? undefined : this.normalizeEmail(dto.email),
          displayName: dto.displayName?.trim(),
          role: dto.role,
          status: dto.status,
        },
      });

      return this.toUserItem(user);
    } catch (error) {
      this.throwUniqueError(error);
      this.throwNotFoundError(error);
      throw error;
    }
  }

  async disableUser(id: string) {
    await this.updateStatus(id, UserStatus.disabled);
    return { success: true };
  }

  async enableUser(id: string) {
    await this.updateStatus(id, UserStatus.active);
    return { success: true };
  }

  async resetPassword(id: string, password: string) {
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      await this.prisma.user.update({
        where: { id },
        data: { passwordHash },
      });
      return { success: true };
    } catch (error) {
      this.throwNotFoundError(error);
      throw error;
    }
  }

  private async updateStatus(id: string, status: UserStatus) {
    try {
      await this.prisma.user.update({
        where: { id },
        data: { status },
      });
    } catch (error) {
      this.throwNotFoundError(error);
      throw error;
    }
  }

  private toUserItem(user: User): UserItem {
    return {
      id: user.id,
      username: user.username,
      email: user.email ?? undefined,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      lastLoginAt: user.lastLoginAt?.toISOString(),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private normalizeEmail(email?: string | null) {
    const value = email?.trim();
    return value ? value : null;
  }

  private throwUniqueError(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      return;
    }

    const target = Array.isArray(error.meta?.target)
      ? error.meta.target.join(",")
      : String(error.meta?.target ?? "");

    if (target.includes("username")) {
      throw new BadRequestException("username 已存在");
    }

    if (target.includes("email")) {
      throw new BadRequestException("email 已存在");
    }

    throw new BadRequestException("用户信息已存在");
  }

  private throwNotFoundError(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw new BadRequestException("用户不存在");
    }
  }
}

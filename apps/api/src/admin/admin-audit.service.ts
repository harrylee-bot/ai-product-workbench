import { Injectable } from "@nestjs/common";
import { AdminAuditTargetType, Prisma } from "@prisma/client";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import type { ListAdminAuditLogsQueryDto } from "./admin.dto";

export type AdminAuditInput = {
  admin: AuthenticatedUser;
  action: string;
  targetType: AdminAuditTargetType;
  targetId?: string;
  detail?: Record<string, unknown>;
  meta?: RequestMeta;
};

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AdminAuditInput) {
    await this.prisma.adminAuditLog.create({
      data: {
        adminUserId: input.admin.id,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        detail: input.detail ? this.sanitizeDetail(input.detail) : undefined,
        ip: input.meta?.ip,
        userAgent: input.meta?.userAgent,
      },
    });
  }

  async list(query: ListAdminAuditLogsQueryDto) {
    const { page, pageSize } = normalizePagination(query);
    const where: Prisma.AdminAuditLogWhereInput = {
      adminUserId: query.adminUserId,
      targetType: query.targetType,
      targetId: query.targetId,
      ...(query.action
        ? { action: { contains: query.action.trim(), mode: "insensitive" } }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          adminUser: {
            select: { id: true, username: true, displayName: true },
          },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      items: items.map((log) => ({
        id: log.id,
        adminUserId: log.adminUserId,
        adminUsername: log.adminUser.username,
        adminDisplayName: log.adminUser.displayName,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId ?? undefined,
        detail: log.detail ?? undefined,
        ip: log.ip ?? undefined,
        userAgent: log.userAgent ?? undefined,
        createdAt: log.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  private sanitizeDetail(detail: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(detail)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          isSensitiveKey(key) ? "****" : normalizeDetailValue(value),
        ]),
    ) as Prisma.InputJsonObject;
  }
}

export function normalizePagination(query: { page?: number; pageSize?: number }) {
  const page = Math.max(Number(query.page ?? 1), 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize ?? 20), 1), 100);
  return { page, pageSize };
}

function normalizeDetailValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeDetailValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "****" : normalizeDetailValue(item),
      ]),
    ) as Prisma.InputJsonObject;
  }
  return value as Prisma.InputJsonValue;
}

function isSensitiveKey(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("password") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("authorization")
  );
}

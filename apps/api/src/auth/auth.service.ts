import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { FileStorageProvider, Prisma, RuntimeRunStatus, User, UserRole, UserStatus } from "@prisma/client";
import { rm } from "node:fs/promises";
import path from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import type { LoginDto, RegisterDto } from "./dto";
import type { AuthJwtPayload, AuthenticatedUser, RequestMeta } from "./auth.types";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(dto: LoginDto, meta?: RequestMeta) {
    const account = (dto.email ?? dto.account ?? "").trim();
    if (!account || !dto.password) {
      await this.recordLoginAttempt({ account, success: false, failReason: "missing_credentials", meta });
      throw new BadRequestException("请输入邮箱和密码");
    }

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: account }, { username: account }],
      },
    });
    if (!user) {
      await this.recordLoginAttempt({ account, success: false, failReason: "account_not_found", meta });
      throw new BadRequestException("账号或密码错误");
    }
    if (user.status === UserStatus.disabled) {
      await this.recordLoginAttempt({
        account,
        userId: user.id,
        success: false,
        failReason: "account_disabled",
        meta,
      });
      throw new ForbiddenException("当前账号已被禁用");
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash).catch(() => false);
    if (!valid) {
      await this.recordLoginAttempt({
        account,
        userId: user.id,
        success: false,
        failReason: "invalid_password",
        meta,
      });
      throw new BadRequestException("账号或密码错误");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      await tx.loginAuditLog.create({
        data: this.loginAuditData({ account, userId: user.id, success: true, meta }),
      });
    });

    const payload: AuthJwtPayload = {
      sub: user.id,
      userId: user.id,
      role: user.role,
      authVersion: user.authVersion,
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
      if (user.authVersion !== tokenAuthVersion(payload)) return null;

      return this.toPublicUser(user);
    } catch {
      return null;
    }
  }

  async register(dto: RegisterDto) {
    if (!this.publicRegistrationEnabled()) {
      throw new ForbiddenException("公开注册未启用");
    }
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
      authVersion: user.authVersion,
    };

    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toPublicUser(user),
    };
  }

  registrationStatus() {
    return { enabled: this.publicRegistrationEnabled() };
  }

  logout() {
    return { success: true };
  }

  async deleteMe(user: AuthenticatedUser) {
    const deleted = await this.prisma.$transaction(async (tx) => {
      const account = await tx.user.findUnique({
        where: { id: user.id },
        select: { id: true, username: true, email: true, role: true },
      });
      if (!account) return null;
      if (account.role === UserRole.admin) {
        throw new ForbiddenException("管理员账号不能通过自助接口删除");
      }

      const conversationIds = await idsFrom(
        tx.conversation.findMany({
          where: { ownerId: account.id },
          select: { id: true },
        }),
      );
      const messageIds = await idsFrom(
        tx.message.findMany({
          where: {
            OR: [
              { conversationId: { in: conversationIds } },
              { userId: account.id },
            ],
          },
          select: { id: true },
        }),
      );
      const runs = await tx.runtimeRunLog.findMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { userId: account.id },
          ],
        },
        select: { id: true, status: true },
      });
      if (runs.some((run) => run.status === RuntimeRunStatus.running)) {
        throw new ConflictException("账号仍有进行中的 Agent 任务，请等待任务结束后重试");
      }
      const runIds = runs.map((run) => run.id);
      const files = await tx.fileAsset.findMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { uploadedBy: account.id },
          ],
        },
        select: {
          id: true,
          conversationId: true,
          storagePath: true,
          storageProvider: true,
        },
      });
      if (files.some((file) => file.storageProvider !== FileStorageProvider.local)) {
        throw new ServiceUnavailableException("账号包含暂不支持自动清理的对象存储文件");
      }
      const fileAssetIds = files.map((file) => file.id);
      const requirementDocumentIds = await idsFrom(
        tx.requirementDocument.findMany({
          where: { conversationId: { in: conversationIds } },
          select: { id: true },
        }),
      );
      const knowledgeItemIds = await idsFrom(
        tx.knowledgeItem.findMany({
          where: {
            OR: [
              { sourceConversationId: { in: conversationIds } },
              { createdBy: account.id },
            ],
          },
          select: { id: true },
        }),
      );
      const deerFlowThreadIds = (
        await tx.deerFlowThreadBinding.findMany({
          where: {
            OR: [
              { conversationId: { in: conversationIds } },
              { userId: account.id },
            ],
          },
          select: { deerFlowThreadId: true },
        })
      ).map((binding) => binding.deerFlowThreadId);
      const deerFlowThreads = await this.deleteDeerFlowThreads(account.id, deerFlowThreadIds);
      if (deerFlowThreads.failed > 0) {
        throw new ServiceUnavailableException("Agent 线程清理失败，请稍后重试账号删除");
      }

      // Delete leaf records before their restrict-on-delete parents. The whole
      // operation is atomic, so a missed dependency cannot leave a half account.
      await tx.comment.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { userId: account.id },
          ],
        },
      });
      await tx.suggestion.deleteMany({
        where: {
          OR: [
            { userId: account.id },
            { documentId: { in: requirementDocumentIds } },
          ],
        },
      });
      await tx.vote.deleteMany({
        where: {
          OR: [
            { userId: account.id },
            { messageId: { in: messageIds } },
          ],
        },
      });
      await tx.knowledgeVersion.deleteMany({
        where: { knowledgeItemId: { in: knowledgeItemIds } },
      });
      await tx.knowledgeItem.deleteMany({
        where: { id: { in: knowledgeItemIds } },
      });
      await tx.knowledgeCandidate.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.knowledgeRetrievalLog.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { runId: { in: runIds } },
          ],
        },
      });
      await tx.vibeStreamEventLog.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { runId: { in: runIds } },
          ],
        },
      });
      await tx.modelCallLog.deleteMany({ where: { runId: { in: runIds } } });
      await tx.runtimeRunLog.deleteMany({ where: { id: { in: runIds } } });
      await tx.deerFlowThreadBinding.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { userId: account.id },
          ],
        },
      });
      await tx.shareLink.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.rollbackRecord.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.qAReport.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.prototypeVersion.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.prototypeArtifact.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.prototypeSpecRecord.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.requirementDocumentVersion.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.requirementDocument.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.conversationDesignChangeLog.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.conversationDesignVersion.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.conversationDesignState.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.prototypeConversionJob.deleteMany({
        where: {
          OR: [
            { conversationId: { in: conversationIds } },
            { fileAssetId: { in: fileAssetIds } },
          ],
        },
      });
      await tx.fileChunk.deleteMany({
        where: { fileAssetId: { in: fileAssetIds } },
      });
      await tx.fileParseResult.deleteMany({
        where: { fileAssetId: { in: fileAssetIds } },
      });
      await tx.fileAsset.deleteMany({ where: { id: { in: fileAssetIds } } });
      await tx.constraintRule.deleteMany({
        where: { conversationId: { in: conversationIds } },
      });
      await tx.message.deleteMany({ where: { id: { in: messageIds } } });
      await tx.stream.deleteMany({ where: { chatId: { in: conversationIds } } });
      await tx.loginAuditLog.deleteMany({
        where: { userId: account.id },
      });
      await tx.adminAuditLog.deleteMany({ where: { adminUserId: account.id } });
      await tx.conversation.deleteMany({ where: { id: { in: conversationIds } } });
      await tx.user.delete({ where: { id: account.id } });

      return { conversationIds, deerFlowThreads, files };
    }, { maxWait: 5_000, timeout: 30_000 });

    const deerFlowThreads = deleted?.deerFlowThreads ?? emptyCleanupResult();
    const localFiles = deleted
      ? await this.deleteLocalAccountFiles(deleted.conversationIds, deleted.files)
      : emptyCleanupResult();
    return {
      success: true,
      cleanupComplete: deerFlowThreads.failed === 0 && localFiles.failed === 0,
      cleanup: { deerFlowThreads, localFiles },
    };
  }

  private async deleteLocalAccountFiles(
    conversationIds: string[],
    files: Array<{
      id: string;
      conversationId: string;
      storagePath: string;
      storageProvider: FileStorageProvider;
    }>,
  ) {
    const uploadRoot = path.resolve(
      this.config.get<string>("FILE_UPLOAD_ROOT") ??
        path.resolve(process.cwd(), "storage/uploads"),
    );
    const targets = new Set<string>();

    for (const conversationId of conversationIds) {
      addPathWithinRoot(targets, uploadRoot, path.join(uploadRoot, conversationId));
    }
    for (const file of files) {
      if (file.storageProvider !== FileStorageProvider.local) continue;
      addPathWithinRoot(targets, uploadRoot, file.storagePath);
      addPathWithinRoot(
        targets,
        uploadRoot,
        path.join(uploadRoot, file.conversationId, `${file.id}_extracted`),
      );
      addPathWithinRoot(
        targets,
        uploadRoot,
        path.join(uploadRoot, file.conversationId, `${file.id}_axure_html`),
      );
    }

    const results = await Promise.all(
      [...targets].map(async (target) => {
        try {
          await rm(target, { force: true, recursive: true });
          return true;
        } catch (error) {
          this.logger.warn(`账号数据文件清理失败：${target} (${String(error)})`);
          return false;
        }
      }),
    );
    const completed = results.filter(Boolean).length;
    return { attempted: results.length, completed, failed: results.length - completed };
  }

  private async deleteDeerFlowThreads(userId: string, threadIds: string[]) {
    const gatewayUrl = (
      this.config.get<string>("DEERFLOW_GATEWAY_URL") ??
      process.env.DEERFLOW_GATEWAY_URL ??
      "http://localhost:8001"
    ).replace(/\/$/, "");
    const internalToken =
      this.config.get<string>("DEER_FLOW_INTERNAL_AUTH_TOKEN") ??
      this.config.get<string>("DEERFLOW_INTERNAL_AUTH_TOKEN") ??
      process.env.DEER_FLOW_INTERNAL_AUTH_TOKEN ??
      process.env.DEERFLOW_INTERNAL_AUTH_TOKEN;
    const headers = {
      "X-DeerFlow-Owner-User-Id": userId,
      ...(internalToken ? { "X-DeerFlow-Internal-Token": internalToken } : {}),
    };

    const results = await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const response = await fetch(
            `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}`,
            {
              method: "DELETE",
              headers,
              signal: AbortSignal.timeout(5_000),
            },
          );
          if (!response.ok && response.status !== 404) {
            this.logger.warn(
              `DeerFlow 线程清理失败：${threadId} (HTTP ${response.status})`,
            );
            return false;
          }
          return true;
        } catch (error) {
          this.logger.warn(`DeerFlow 线程清理失败：${threadId} (${String(error)})`);
          return false;
        }
      }),
    );
    const completed = results.filter(Boolean).length;
    return { attempted: results.length, completed, failed: results.length - completed };
  }

  async logoutAll(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { authVersion: { increment: 1 } },
    });
    return { success: true };
  }

  private async recordLoginAttempt(input: {
    account: string;
    userId?: string;
    success: boolean;
    failReason?: string;
    meta?: RequestMeta;
  }) {
    await this.prisma.loginAuditLog.create({ data: this.loginAuditData(input) });
  }

  private loginAuditData(input: {
    account: string;
    userId?: string;
    success: boolean;
    failReason?: string;
    meta?: RequestMeta;
  }): Prisma.LoginAuditLogUncheckedCreateInput {
    return {
      ...(input.userId ? { userId: input.userId } : {}),
      account: sanitizeAuditText(input.account || "(missing)", 320) ?? "(missing)",
      success: input.success,
      failReason: input.failReason,
      ip: sanitizeAuditText(input.meta?.ip, 128),
      userAgent: sanitizeAuditText(input.meta?.userAgent, 1000),
    };
  }

  private publicRegistrationEnabled() {
    const configured = this.config.get<string>("PUBLIC_REGISTRATION_ENABLED")?.trim().toLowerCase();
    if (configured) return configured === "true" || configured === "1";
    return this.config.get<string>("NODE_ENV") !== "production";
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

async function idsFrom(
  rows: Promise<Array<{ id: string }>>,
): Promise<string[]> {
  return (await rows).map((row) => row.id);
}

function addPathWithinRoot(targets: Set<string>, root: string, candidate: string) {
  const resolved = path.resolve(candidate);
  if (resolved !== root && resolved.startsWith(`${root}${path.sep}`)) {
    targets.add(resolved);
  }
}

function emptyCleanupResult() {
  return { attempted: 0, completed: 0, failed: 0 };
}

function tokenAuthVersion(payload: AuthJwtPayload) {
  return Number.isSafeInteger(payload.authVersion) ? payload.authVersion! : 0;
}

function sanitizeAuditText(value: string | undefined, maxLength: number) {
  const normalized = value?.replace(/[\r\n\0]/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

import { Body, Controller, Delete, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ShareScope } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { CreateShareLinkDto } from "./share.dto";
import { ShareService } from "./share.service";
import { USER_HTML_CSP } from "./user-html-security";

/** 创建/管理分享链接：仅会话 owner（需登录）。 */
@Controller("share-links")
@UseGuards(JwtAuthGuard)
export class ShareLinkController {
  constructor(private readonly shareService: ShareService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateShareLinkDto) {
    return this.shareService.createForUser(user, {
      conversationId: dto.conversationId,
      scope: dto.scope as ShareScope | undefined,
      expiresInDays: dto.expiresInDays,
    });
  }

  @Get("conversations/:conversationId")
  list(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.shareService.listForUser(user, conversationId);
  }

  @Delete(":shareId")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("shareId") shareId: string) {
    return this.shareService.revokeForUser(user, shareId);
  }
}

/**
 * 分享链接访问：需要登录（根据需求：不支持游客访问）。
 * 用户登录后可查看分享内容，只读、不可下载、不可编辑（FR-4.2/4.3）。
 */
@Controller("authenticated-share")
@UseGuards(JwtAuthGuard)
export class AuthenticatedShareController {
  constructor(private readonly shareService: ShareService) {}

  // sec-3：分享接口限流防刷量（30 次/分钟/用户）。
  @Throttle({ share: { limit: 30, ttl: 60_000 } })
  @Get(":token")
  resolve(@Param("token") token: string) {
    return this.shareService.resolveAuthenticatedShare(token);
  }

  @Throttle({ share: { limit: 30, ttl: 60_000 } })
  @Get(":token/prototype")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", USER_HTML_CSP)
  @Header("X-Content-Type-Options", "nosniff")
  prototypeHtml(@Param("token") token: string) {
    return this.shareService.resolveAuthenticatedPrototypeHtml(token);
  }
}

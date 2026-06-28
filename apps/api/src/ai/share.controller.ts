import { Body, Controller, Delete, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ShareScope } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { CreateShareLinkDto } from "./share.dto";
import { ShareService } from "./share.service";

/** 创建/管理分享链接：仅项目 owner（需登录）。 */
@Controller("share-links")
@UseGuards(JwtAuthGuard)
export class ShareLinkController {
  constructor(private readonly shareService: ShareService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateShareLinkDto) {
    return this.shareService.createForUser(user, {
      projectId: dto.projectId,
      scope: dto.scope as ShareScope | undefined,
      expiresInDays: dto.expiresInDays,
    });
  }

  @Get("project/:projectId")
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.shareService.listForUser(user, projectId);
  }

  @Delete(":shareId")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("shareId") shareId: string) {
    return this.shareService.revokeForUser(user, shareId);
  }
}

/** 公开只读访问：免登录（无 Guard），只读、不可下载、不可编辑（FR-4.2/4.3）。 */
@Controller("public/share")
export class PublicShareController {
  constructor(private readonly shareService: ShareService) {}

  // sec-3：公开分享接口限流防刷量（30 次/分钟/IP）。
  @Throttle({ public: { limit: 30, ttl: 60_000 } })
  @Get(":token")
  resolve(@Param("token") token: string) {
    return this.shareService.resolvePublic(token);
  }

  @Throttle({ public: { limit: 30, ttl: 60_000 } })
  @Get(":token/prototype")
  @Header("Content-Type", "text/html; charset=utf-8")
  prototypeHtml(@Param("token") token: string) {
    return this.shareService.resolvePublicPrototypeHtml(token);
  }
}

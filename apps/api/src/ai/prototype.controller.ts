import { Body, Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ConfirmPrototypeDto, GetPrototypeStateDto } from "./prototype.dto";
import { PrototypeService } from "./prototype.service";
import { USER_HTML_CSP } from "./user-html-security";

@Controller("conversations/:conversationId/prototype")
@UseGuards(JwtAuthGuard)
export class ConversationPrototypeController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Get("current")
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.prototypeService.getCurrentForUser(user, conversationId);
  }
}

@Controller("prototype")
@UseGuards(JwtAuthGuard)
export class PrototypeStateController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Post("get")
  get(@CurrentUser() user: AuthenticatedUser, @Body() dto: GetPrototypeStateDto) {
    return this.prototypeService.getPrototypeStateForUser(user, dto);
  }
}

@Controller("prototype-artifacts")
@UseGuards(JwtAuthGuard)
export class PrototypeArtifactController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Get(":artifactId")
  getArtifact(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.getArtifactForUser(user, artifactId);
  }

  @Get(":artifactId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", USER_HTML_CSP)
  @Header("X-Content-Type-Options", "nosniff")
  getPreviewHtml(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.getPreviewHtmlForUser(user, artifactId);
  }

  @Get(":artifactId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.listVersionsForUser(user, artifactId);
  }

  @Post(":artifactId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("artifactId") artifactId: string,
    @Body() dto: ConfirmPrototypeDto,
  ) {
    return this.prototypeService.confirmForUser(user, artifactId, dto.reason);
  }
}

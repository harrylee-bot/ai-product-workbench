import { Body, Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ConfirmPrototypeDto, GeneratePrototypeDto } from "./prototype.dto";
import { PrototypeService } from "./prototype.service";

@Controller("projects/:projectId/prototype")
@UseGuards(JwtAuthGuard)
export class ProjectPrototypeController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Post("generate")
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: GeneratePrototypeDto,
  ) {
    return this.prototypeService.generateForUser(user, projectId, dto);
  }

  @Get("current")
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.prototypeService.getCurrentForUser(user, projectId);
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

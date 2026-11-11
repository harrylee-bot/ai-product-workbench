import { Controller, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { SourcePrototypePreviewService } from "./source-prototype-preview.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class SourcePrototypePreviewController {
  constructor(private readonly previews: SourcePrototypePreviewService) {}

  @Post("artifacts/:artifactId/versions/:artifactVersionId/preview-token")
  @HttpCode(200)
  create(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") versionId: string, @Res({ passthrough: true }) response: Response) {
    headers(response);
    return this.previews.createPrivate(principal.id, artifactId, versionId);
  }
}

@Controller()
export class PublicSourcePrototypePreviewController {
  constructor(private readonly previews: SourcePrototypePreviewService) {}

  @Post("public/shares/:shareToken/artifacts/:artifactId/versions/:artifactVersionId/preview-token")
  @HttpCode(200)
  create(@Param("shareToken") shareToken: string, @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") versionId: string, @Res({ passthrough: true }) response: Response) {
    headers(response);
    return this.previews.createPublic(shareToken, artifactId, versionId);
  }
}

function headers(response: Response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}

import { Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import type { ExportArtifact } from "./export.service";
import { ExportService } from "./export.service";

@Controller("projects/:projectId/export")
@UseGuards(JwtAuthGuard)
export class ProjectExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get("word")
  async exportWord(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const artifact = await this.exportService.exportPrdWordForUser(user, projectId);
    setDownloadHeaders(response, artifact);
    return artifact.buffer;
  }

  @Get("html")
  async exportHtml(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const artifact = await this.exportService.exportPrototypeHtmlForUser(user, projectId);
    setDownloadHeaders(response, artifact);
    return artifact.buffer;
  }
}

function setDownloadHeaders(response: Response, artifact: ExportArtifact) {
  response.setHeader("Content-Type", artifact.contentType);
  response.setHeader("Content-Length", String(artifact.sizeBytes));
  response.setHeader("Content-Disposition", contentDisposition(artifact.fileName));
  response.setHeader("X-Product-Design-State-Id", artifact.productDesignStateId);
  response.setHeader("X-Product-Design-State-Version", String(artifact.productDesignStateVersion));
  response.setHeader("X-Export-Source-Id", artifact.sourceId);
}

function contentDisposition(fileName: string) {
  const asciiFallback = fileName.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

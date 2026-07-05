import { Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import type { ExportArtifact } from "./export.service";
import { ExportService } from "./export.service";

@Controller("conversations/:conversationId/export")
@UseGuards(JwtAuthGuard)
export class ConversationExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get("word")
  async exportWord(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Res() response: Response,
  ) {
    const artifact = await this.exportService.exportPrdWordForUser(user, conversationId);
    sendDownload(response, artifact);
  }

  @Get("html")
  async exportHtml(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Res() response: Response,
  ) {
    const artifact = await this.exportService.exportPrototypeHtmlForUser(user, conversationId);
    sendDownload(response, artifact);
  }

  @Get("canvas")
  async exportCanvas(
    @CurrentUser() user: AuthenticatedUser,
    @Param("conversationId") conversationId: string,
    @Res() response: Response,
  ) {
    const artifact = await this.exportService.exportPrdCanvasForUser(user, conversationId);
    sendDownload(response, artifact);
  }
}

function sendDownload(response: Response, artifact: ExportArtifact) {
  setDownloadHeaders(response, artifact);
  response.send(artifact.buffer);
}

function setDownloadHeaders(response: Response, artifact: ExportArtifact) {
  response.setHeader("Content-Type", artifact.contentType);
  response.setHeader("Content-Length", String(artifact.sizeBytes));
  response.setHeader("Content-Disposition", contentDisposition(artifact.fileName));
  response.setHeader("X-Conversation-Design-State-Id", artifact.conversationDesignStateId);
  response.setHeader("X-Conversation-Design-State-Version", String(artifact.conversationDesignStateVersion));
  response.setHeader("X-Export-Source-Id", artifact.sourceId);
}

function contentDisposition(fileName: string) {
  const asciiFallback = fileName.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

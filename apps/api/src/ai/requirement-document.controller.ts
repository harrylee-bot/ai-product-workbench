import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { DocumentCanvasService } from "./document-canvas.service";
import {
  ConfirmPrdDto,
  UpdatePrdDocumentDto,
  UpdatePrdSectionDto,
} from "./requirement-document.dto";
import { RequirementDocumentService } from "./requirement-document.service";

@Controller("conversations/:conversationId/prd")
@UseGuards(JwtAuthGuard)
export class ConversationPrdController {
  constructor(private readonly documentService: RequirementDocumentService) {}

  @Get("current")
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("conversationId") conversationId: string) {
    return this.documentService.getCurrentForUser(user, conversationId);
  }
}

@Controller("prd-documents")
@UseGuards(JwtAuthGuard)
export class PrdDocumentController {
  constructor(
    private readonly documentService: RequirementDocumentService,
    private readonly canvasService: DocumentCanvasService,
  ) {}

  @Get(":documentId")
  getDocument(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.getDocumentForUser(user, documentId);
  }

  @Get(":documentId/preview")
  getPreview(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.getPreviewForUser(user, documentId);
  }

  @Patch(":documentId")
  updateDocument(
    @CurrentUser() user: AuthenticatedUser,
    @Param("documentId") documentId: string,
    @Body() dto: UpdatePrdDocumentDto,
  ) {
    return this.documentService.updateDocumentContentForUser(user, documentId, dto);
  }

  @Get(":documentId/canvas")
  getCanvas(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.canvasService.getCanvasForUser(user, documentId);
  }

  @Post(":documentId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("documentId") documentId: string,
    @Body() dto: ConfirmPrdDto,
  ) {
    return this.documentService.confirmForUser(user, documentId, dto.reason);
  }

  @Patch(":documentId/sections/:sectionId")
  updateSection(
    @CurrentUser() user: AuthenticatedUser,
    @Param("documentId") documentId: string,
    @Param("sectionId") sectionId: string,
    @Body() dto: UpdatePrdSectionDto,
  ) {
    return this.documentService.updateSectionForUser(user, documentId, sectionId, dto);
  }

  @Get(":documentId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.listVersionsForUser(user, documentId);
  }
}

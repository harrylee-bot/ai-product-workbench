import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ConfirmPrdDto, GeneratePrdDto } from "./requirement-document.dto";
import { RequirementDocumentService } from "./requirement-document.service";

@Controller("projects/:projectId/prd")
@UseGuards(JwtAuthGuard)
export class ProjectPrdController {
  constructor(private readonly documentService: RequirementDocumentService) {}

  @Post("generate")
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: GeneratePrdDto,
  ) {
    return this.documentService.generateForUser(user, projectId, dto);
  }

  @Get("current")
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.documentService.getCurrentForUser(user, projectId);
  }
}

@Controller("prd-documents")
@UseGuards(JwtAuthGuard)
export class PrdDocumentController {
  constructor(private readonly documentService: RequirementDocumentService) {}

  @Get(":documentId")
  getDocument(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.getDocumentForUser(user, documentId);
  }

  @Get(":documentId/preview")
  getPreview(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.getPreviewForUser(user, documentId);
  }

  @Post(":documentId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("documentId") documentId: string,
    @Body() dto: ConfirmPrdDto,
  ) {
    return this.documentService.confirmForUser(user, documentId, dto.reason);
  }

  @Get(":documentId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("documentId") documentId: string) {
    return this.documentService.listVersionsForUser(user, documentId);
  }
}

import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthenticatedUser, RequestMeta } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { CurrentRequestMeta } from "../common/request-meta.decorator";
import { KnowledgeCandidateService } from "./knowledge-candidate.service";
import {
  ApproveKnowledgeCandidateDto,
  CreateKnowledgeCategoryDto,
  CreateKnowledgeItemDto,
  ListKnowledgeCandidatesQueryDto,
  ListKnowledgeItemsQueryDto,
  MergeKnowledgeCandidateDto,
  RejectKnowledgeCandidateDto,
  UpdateKnowledgeItemDto,
} from "./knowledge.dto";
import { KnowledgeItemService } from "./knowledge-item.service";
import { ObsidianVaultService } from "./obsidian-vault.service";

@Controller("admin/knowledge")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class KnowledgeAdminController {
  constructor(
    private readonly items: KnowledgeItemService,
    private readonly candidates: KnowledgeCandidateService,
    private readonly vault: ObsidianVaultService,
  ) {}

  @Get("vault")
  getVaultStatus() {
    return this.vault.getStatus();
  }

  @Post("vault/init")
  initializeVault() {
    return this.vault.initialize();
  }

  @Post("vault/sync")
  syncVault(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.syncToKnowledgeBase(user);
  }

  @Post("items")
  createItem(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Body() dto: CreateKnowledgeItemDto,
  ) {
    return this.items.createItem(user, dto, meta);
  }

  @Get("items")
  listItems(@Query() query: ListKnowledgeItemsQueryDto) {
    return this.items.listItems(query);
  }

  @Get("items/:knowledgeId")
  getItem(@Param("knowledgeId") knowledgeId: string) {
    return this.items.getItem(knowledgeId);
  }

  @Patch("items/:knowledgeId")
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("knowledgeId") knowledgeId: string,
    @Body() dto: UpdateKnowledgeItemDto,
  ) {
    return this.items.updateItem(user, knowledgeId, dto, meta);
  }

  @Post("items/:knowledgeId/enable")
  enableItem(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("knowledgeId") knowledgeId: string,
  ) {
    return this.items.enableItem(user, knowledgeId, meta);
  }

  @Post("items/:knowledgeId/disable")
  disableItem(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("knowledgeId") knowledgeId: string,
  ) {
    return this.items.disableItem(user, knowledgeId, meta);
  }

  @Post("categories")
  createCategory(@Body() dto: CreateKnowledgeCategoryDto) {
    return this.items.createCategory(dto);
  }

  @Get("categories")
  listCategories() {
    return this.items.listCategories();
  }

  @Get("candidates")
  listCandidates(@Query() query: ListKnowledgeCandidatesQueryDto) {
    return this.candidates.listCandidates(query);
  }

  @Post("candidates/:candidateId/approve")
  approveCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("candidateId") candidateId: string,
    @Body() dto: ApproveKnowledgeCandidateDto,
  ) {
    return this.candidates.approveCandidate(user, candidateId, dto, meta);
  }

  @Post("candidates/:candidateId/reject")
  rejectCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("candidateId") candidateId: string,
    @Body() dto: RejectKnowledgeCandidateDto,
  ) {
    return this.candidates.rejectCandidate(user, candidateId, dto, meta);
  }

  @Post("candidates/:candidateId/merge")
  mergeCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentRequestMeta() meta: RequestMeta,
    @Param("candidateId") candidateId: string,
    @Body() dto: MergeKnowledgeCandidateDto,
  ) {
    return this.candidates.mergeCandidate(user, candidateId, dto, meta);
  }
}

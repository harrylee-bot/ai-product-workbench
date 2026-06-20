import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CurrentUser } from "../common/current-user.decorator";
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

@Controller("admin/knowledge")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin)
export class KnowledgeAdminController {
  constructor(
    private readonly items: KnowledgeItemService,
    private readonly candidates: KnowledgeCandidateService,
  ) {}

  @Post("items")
  createItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateKnowledgeItemDto) {
    return this.items.createItem(user, dto);
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
    @Param("knowledgeId") knowledgeId: string,
    @Body() dto: UpdateKnowledgeItemDto,
  ) {
    return this.items.updateItem(user, knowledgeId, dto);
  }

  @Post("items/:knowledgeId/enable")
  enableItem(@CurrentUser() user: AuthenticatedUser, @Param("knowledgeId") knowledgeId: string) {
    return this.items.enableItem(user, knowledgeId);
  }

  @Post("items/:knowledgeId/disable")
  disableItem(@CurrentUser() user: AuthenticatedUser, @Param("knowledgeId") knowledgeId: string) {
    return this.items.disableItem(user, knowledgeId);
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
    @Param("candidateId") candidateId: string,
    @Body() dto: ApproveKnowledgeCandidateDto,
  ) {
    return this.candidates.approveCandidate(user, candidateId, dto);
  }

  @Post("candidates/:candidateId/reject")
  rejectCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("candidateId") candidateId: string,
    @Body() dto: RejectKnowledgeCandidateDto,
  ) {
    return this.candidates.rejectCandidate(user, candidateId, dto);
  }

  @Post("candidates/:candidateId/merge")
  mergeCandidate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("candidateId") candidateId: string,
    @Body() dto: MergeKnowledgeCandidateDto,
  ) {
    return this.candidates.mergeCandidate(user, candidateId, dto);
  }
}

import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import {
  ConfirmPatchDto,
  CreatePatchDraftDto,
  CreatePatchDto,
  ListPatchRecordsQueryDto,
  PreviewPatchDto,
} from "./patch.dto";
import { PatchService } from "./patch.service";

@Controller("projects/:projectId/patches")
@UseGuards(JwtAuthGuard)
export class ProjectPatchController {
  constructor(private readonly patchService: PatchService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: CreatePatchDto,
  ) {
    return this.patchService.createPatchForUser(user, projectId, dto);
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Query() query: ListPatchRecordsQueryDto,
  ) {
    return this.patchService.listForProject(user, projectId, query);
  }
}

@Controller("patch")
@UseGuards(JwtAuthGuard)
export class PatchDraftController {
  constructor(private readonly patchService: PatchService) {}

  @Post("draft")
  draft(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePatchDraftDto) {
    const action = dto.action ?? "edit";
    return this.patchService.createPatchCandidateForUser(user, dto.projectId, {
      conversationId: dto.conversationId,
      selectedRegion: withDraftSelectedText(dto.selectedRegion, dto.selectedText),
      userInstruction: draftInstruction(dto, action),
      attachmentFileIds: dto.attachmentFileIds,
      source: dto.source ?? "inline_edit",
      interactionEvent: {
        ...dto.interactionEvent,
        action,
        selectedText: dto.selectedText,
        replacementText: dto.replacementText,
        diffBaseText: dto.diffBaseText,
        diffTargetText: dto.diffTargetText,
      },
    });
  }

  @Post("preview")
  preview(@CurrentUser() user: AuthenticatedUser, @Body() dto: PreviewPatchDto) {
    return this.patchService.previewForUser(user, dto.patchId);
  }
}

@Controller("patches")
@UseGuards(JwtAuthGuard)
export class PatchResourceController {
  constructor(private readonly patchService: PatchService) {}

  @Get(":patchId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("patchId") patchId: string) {
    return this.patchService.getPatchForUser(user, patchId);
  }

  @Post(":patchId/cancel")
  cancel(@CurrentUser() user: AuthenticatedUser, @Param("patchId") patchId: string) {
    return this.patchService.cancelForUser(user, patchId);
  }

  @Post(":patchId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("patchId") patchId: string,
    @Body() dto: ConfirmPatchDto,
  ) {
    return this.patchService.confirmForUser(user, patchId, dto.userConfirmation);
  }
}

function withDraftSelectedText(region: Record<string, unknown>, selectedText?: string) {
  return selectedText ? { ...region, selectedText } : region;
}

function draftInstruction(dto: CreatePatchDraftDto, action: string) {
  const instruction = dto.instruction ?? dto.userInstruction ?? "";
  const lines = [
    `编辑动作：${action}`,
    dto.selectedText ? `选区内容：${dto.selectedText}` : "",
    dto.diffBaseText ? `原内容：${dto.diffBaseText}` : "",
    dto.diffTargetText ? `目标内容：${dto.diffTargetText}` : "",
    dto.replacementText ? `建议替换为：${dto.replacementText}` : "",
    `用户指令：${instruction.trim()}`,
  ].filter(Boolean);
  return lines.join("\n");
}

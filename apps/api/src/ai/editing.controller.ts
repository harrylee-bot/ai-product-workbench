import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { EditingPatchDto } from "./editing.dto";
import { PatchService } from "./patch.service";

type EditingSource =
  | "prd_edit"
  | "prd_rewrite"
  | "prd_diff"
  | "prototype_edit"
  | "prototype_restructure"
  | "prototype_flow_update"
  | "inline_edit";

@Controller("prd")
@UseGuards(JwtAuthGuard)
export class PrdEditingController {
  constructor(private readonly patchService: PatchService) {}

  @Post("edit")
  edit(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prd_edit", "edit");
  }

  @Post("rewrite")
  rewrite(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prd_rewrite", dto.action ?? "rewrite");
  }

  @Post("diff")
  diff(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prd_diff", "diff");
  }

  private createCandidate(
    user: AuthenticatedUser,
    dto: EditingPatchDto,
    source: EditingSource,
    defaultAction: string,
  ) {
    const action = dto.action ?? defaultAction;
    return this.patchService.createPatchCandidateForUser(user, dto.projectId, {
      conversationId: dto.conversationId,
      selectedRegion: withSelectedText(dto.selectedRegion, dto.selectedText),
      userInstruction: buildInstruction(dto, action),
      attachmentFileIds: dto.attachmentFileIds,
      source,
      interactionEvent: interactionEvent(dto, action),
    });
  }
}

@Controller("prototype")
@UseGuards(JwtAuthGuard)
export class PrototypeEditingController {
  constructor(private readonly patchService: PatchService) {}

  @Post("edit")
  edit(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prototype_edit", dto.action ?? "component_edit");
  }

  @Post("restructure")
  restructure(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prototype_restructure", dto.action ?? "layout_edit");
  }

  @Post("flow-update")
  flowUpdate(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    return this.createCandidate(user, dto, "prototype_flow_update", "flow_update");
  }

  private createCandidate(
    user: AuthenticatedUser,
    dto: EditingPatchDto,
    source: EditingSource,
    defaultAction: string,
  ) {
    const action = dto.action ?? defaultAction;
    return this.patchService.createPatchCandidateForUser(user, dto.projectId, {
      conversationId: dto.conversationId,
      selectedRegion: withSelectedText(dto.selectedRegion, dto.selectedText),
      userInstruction: buildInstruction(dto, action),
      attachmentFileIds: dto.attachmentFileIds,
      source,
      interactionEvent: interactionEvent(dto, action),
    });
  }
}

@Controller("ai")
@UseGuards(JwtAuthGuard)
export class InlineAssistantController {
  constructor(private readonly patchService: PatchService) {}

  @Post("inline-edit")
  inlineEdit(@CurrentUser() user: AuthenticatedUser, @Body() dto: EditingPatchDto) {
    const action = dto.action ?? "rewrite";
    return this.patchService.createPatchCandidateForUser(user, dto.projectId, {
      conversationId: dto.conversationId,
      selectedRegion: withSelectedText(dto.selectedRegion, dto.selectedText),
      userInstruction: buildInstruction(dto, action),
      attachmentFileIds: dto.attachmentFileIds,
      source: "inline_edit",
      interactionEvent: interactionEvent(dto, action),
    });
  }
}

function withSelectedText(region: Record<string, unknown>, selectedText?: string) {
  return selectedText ? { ...region, selectedText } : region;
}

function buildInstruction(dto: EditingPatchDto, action: string) {
  const lines = [
    `编辑动作：${action}`,
    dto.selectedText ? `选区内容：${dto.selectedText}` : "",
    dto.diffBaseText ? `原内容：${dto.diffBaseText}` : "",
    dto.diffTargetText ? `目标内容：${dto.diffTargetText}` : "",
    dto.replacementText ? `建议替换为：${dto.replacementText}` : "",
    `用户指令：${dto.instruction.trim()}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function interactionEvent(dto: EditingPatchDto, action: string) {
  return {
    action,
    selectedText: dto.selectedText,
    hasReplacement: Boolean(dto.replacementText),
    hasDiff: Boolean(dto.diffBaseText || dto.diffTargetText),
    selectedRegion: dto.selectedRegion,
  };
}

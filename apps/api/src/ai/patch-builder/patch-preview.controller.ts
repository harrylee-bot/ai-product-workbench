import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../../modules/auth/current-user.decorator";
import { JwtAuthGuard } from "../../modules/auth/jwt-auth.guard";
import type { Phase1User } from "../../modules/auth/auth.types";
import type { PatchDraft } from "./patch-builder.service";
import { PatchPreviewRequestDto } from "./patch-preview.dto";
import { PatchPreviewService } from "./patch-preview.service";

@Controller("patch")
@UseGuards(JwtAuthGuard)
export class PatchPreviewController {
  constructor(private readonly previews: PatchPreviewService) {}

  @Post("preview")
  preview(@CurrentUser() user: Phase1User, @Body() dto: PatchPreviewRequestDto) {
    const draft = normalizeDraft(dto);
    return this.previews.createPreview({
      user,
      projectId: dto.projectId ?? "",
      conversationId: dto.conversationId ?? "",
      draft,
      userInstruction: "手动补丁预览请求",
    });
  }
}

function normalizeDraft(dto: PatchPreviewRequestDto): PatchDraft {
  const draft = dto.draft ?? dto;
  return {
    id: draft.id,
    strategyId: draft.strategyId,
    operations: draft.operations,
    targetDomains: draft.targetDomains,
  };
}

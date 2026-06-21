import { Body, Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { ConfirmPrototypeDto, GeneratePrototypeDto, GetPrototypeStateDto, UpdatePrototypeDto } from "./prototype.dto";
import { PatchService } from "./patch.service";
import { PrototypeService } from "./prototype.service";

@Controller("projects/:projectId/prototype")
@UseGuards(JwtAuthGuard)
export class ProjectPrototypeController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Post("generate")
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: GeneratePrototypeDto,
  ) {
    return this.prototypeService.generateForUser(user, projectId, dto);
  }

  @Get("current")
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.prototypeService.getCurrentForUser(user, projectId);
  }
}

@Controller("prototype")
@UseGuards(JwtAuthGuard)
export class PrototypeStateController {
  constructor(
    private readonly prototypeService: PrototypeService,
    private readonly patchService: PatchService,
  ) {}

  @Post("get")
  get(@CurrentUser() user: AuthenticatedUser, @Body() dto: GetPrototypeStateDto) {
    return this.prototypeService.getPrototypeStateForUser(user, dto);
  }

  @Post("update")
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePrototypeDto) {
    const action = dto.action ?? "component_edit";
    return this.patchService.createPatchCandidateForUser(user, dto.projectId, {
      conversationId: dto.conversationId,
      selectedRegion: dto.selectedText
        ? { ...dto.selectedRegion, selectedText: dto.selectedText }
        : dto.selectedRegion,
      userInstruction: [
        `编辑动作：${action}`,
        dto.selectedText ? `选区内容：${dto.selectedText}` : "",
        `用户指令：${dto.instruction.trim()}`,
      ].filter(Boolean).join("\n"),
      attachmentFileIds: dto.attachmentFileIds,
      source: action === "flow_update"
        ? "prototype_flow_update"
        : action === "layout_edit"
          ? "prototype_restructure"
          : "prototype_edit",
      interactionEvent: {
        source: "prototype_interaction_system",
        action,
        selectedText: dto.selectedText,
        selectedRegion: dto.selectedRegion,
        ...(dto.interactionEvent ?? {}),
      },
    });
  }
}

@Controller("prototype-artifacts")
@UseGuards(JwtAuthGuard)
export class PrototypeArtifactController {
  constructor(private readonly prototypeService: PrototypeService) {}

  @Get(":artifactId")
  getArtifact(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.getArtifactForUser(user, artifactId);
  }

  @Get(":artifactId/preview")
  @Header("Content-Type", "text/html; charset=utf-8")
  getPreviewHtml(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.getPreviewHtmlForUser(user, artifactId);
  }

  @Get(":artifactId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("artifactId") artifactId: string) {
    return this.prototypeService.listVersionsForUser(user, artifactId);
  }

  @Post(":artifactId/confirm")
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param("artifactId") artifactId: string,
    @Body() dto: ConfirmPrototypeDto,
  ) {
    return this.prototypeService.confirmForUser(user, artifactId, dto.reason);
  }
}

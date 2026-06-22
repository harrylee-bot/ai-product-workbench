import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { EvolutionEngineService } from "./evolution-engine.service";
import { EvolutionOrchestratorService } from "./evolution-orchestrator.service";
import { FeedbackAnalysisService } from "./feedback-analysis.service";
import { InteractionCaptureService } from "./interaction-capture.service";
import { MultiAgentReviewService } from "./multi-agent-review.service";
import { PatchExecutionEngineService } from "./patch-execution-engine.service";
import { ProductMemoryService } from "./product-memory.service";
import {
  AiSuggestDto,
  AnalyzeFeedbackDto,
  ApplyEvolutionPlanDto,
  CreateContractEventDto,
  CreateInteractionDto,
  RollbackPatchDto,
  RunEvolutionCycleDto,
  RunProjectWorkflowDto,
  SaveProductMemoryDto,
} from "./product-evolution.dto";

@Controller("interactions")
@UseGuards(JwtAuthGuard)
export class InteractionController {
  constructor(private readonly interactionCapture: InteractionCaptureService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateInteractionDto) {
    return this.interactionCapture.createForUser(user, dto);
  }
}

@Controller("projects/:projectId/interactions")
@UseGuards(JwtAuthGuard)
export class ProjectInteractionController {
  constructor(private readonly interactionCapture: InteractionCaptureService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.interactionCapture.listForProject(user, projectId);
  }
}

@Controller("events")
@UseGuards(JwtAuthGuard)
export class EventController {
  constructor(private readonly interactionCapture: InteractionCaptureService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContractEventDto) {
    return this.interactionCapture.createContractEventForUser(user, dto);
  }
}

@Controller("ai")
@UseGuards(JwtAuthGuard)
export class AiSuggestionController {
  @Post("suggest")
  suggest(@Body() dto: AiSuggestDto) {
    const action = dto.action ?? "component_edit";
    const label = typeof dto.selectedRegion.label === "string"
      ? dto.selectedRegion.label
      : typeof dto.selectedRegion.componentId === "string"
        ? dto.selectedRegion.componentId
        : "选中组件";

    return {
      suggestion: {
        action,
        title: `建议优化「${label}」`,
        summary: "智能建议已整理为补丁草稿输入，确认生成后才会进入补丁预览。",
        instruction: `请针对「${label}」执行${prototypeActionLabel(action)}：${dto.instruction.trim()}`,
        selectedRegion: dto.selectedRegion,
        patchDraft: {
          projectId: dto.projectId,
          selectedRegion: dto.selectedRegion,
          action,
          source: action === "flow_update"
            ? "prototype_flow_update"
            : action === "layout_edit"
              ? "prototype_restructure"
              : "prototype_edit",
        },
      },
    };
  }
}

@Controller("feedback")
@UseGuards(JwtAuthGuard)
export class FeedbackAnalysisController {
  constructor(private readonly feedbackAnalysis: FeedbackAnalysisService) {}

  @Post("analyze")
  analyze(@CurrentUser() user: AuthenticatedUser, @Body() dto: AnalyzeFeedbackDto) {
    return this.feedbackAnalysis.analyzeForUser(user, dto);
  }
}

function prototypeActionLabel(action: NonNullable<AiSuggestDto["action"]>) {
  if (action === "layout_edit") return "布局调整";
  if (action === "flow_update") return "流程优化";
  if (action === "redesign") return "组件优化";
  return "组件编辑";
}

@Controller("projects/:projectId/insights")
@UseGuards(JwtAuthGuard)
export class ProjectInsightController {
  constructor(private readonly feedbackAnalysis: FeedbackAnalysisService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.feedbackAnalysis.listForProject(user, projectId);
  }
}

@Controller("review")
@UseGuards(JwtAuthGuard)
export class MultiAgentReviewController {
  constructor(private readonly multiAgentReview: MultiAgentReviewService) {}

  @Post("run")
  run(@CurrentUser() user: AuthenticatedUser, @Body() dto: RunProjectWorkflowDto) {
    return this.multiAgentReview.runForUser(user, dto);
  }
}

@Controller("projects/:projectId/review")
@UseGuards(JwtAuthGuard)
export class ProjectReviewController {
  constructor(private readonly multiAgentReview: MultiAgentReviewService) {}

  @Get("latest")
  latest(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.multiAgentReview.getLatestForUser(user, projectId);
  }
}

@Controller("evolution")
@UseGuards(JwtAuthGuard)
export class EvolutionController {
  constructor(
    private readonly evolutionEngine: EvolutionEngineService,
    private readonly evolutionOrchestrator: EvolutionOrchestratorService,
  ) {}

  @Post("run")
  run(@CurrentUser() user: AuthenticatedUser, @Body() dto: RunProjectWorkflowDto) {
    return this.evolutionEngine.runForUser(user, dto);
  }

  @Post("run-cycle")
  runCycle(@CurrentUser() user: AuthenticatedUser, @Body() dto: RunEvolutionCycleDto) {
    return this.evolutionOrchestrator.runCycleForUser(user, dto);
  }

  @Get("run/:runId")
  getRun(@CurrentUser() user: AuthenticatedUser, @Param("runId") runId: string) {
    return this.evolutionOrchestrator.getRunForUser(user, runId);
  }

  @Get("status/:projectId")
  status(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.evolutionOrchestrator.getStatusForUser(user, projectId);
  }
}

@Controller("projects/:projectId/evolution")
@UseGuards(JwtAuthGuard)
export class ProjectEvolutionController {
  constructor(private readonly evolutionEngine: EvolutionEngineService) {}

  @Get("latest")
  latest(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.evolutionEngine.getLatestForUser(user, projectId);
  }
}

@Controller("patch")
@UseGuards(JwtAuthGuard)
export class PatchExecutionController {
  constructor(private readonly patchExecutionEngine: PatchExecutionEngineService) {}

  @Post("apply")
  apply(@CurrentUser() user: AuthenticatedUser, @Body() dto: ApplyEvolutionPlanDto) {
    return this.patchExecutionEngine.applyForUser(user, dto);
  }

  @Post("rollback")
  rollback(@CurrentUser() user: AuthenticatedUser, @Body() dto: RollbackPatchDto) {
    return this.patchExecutionEngine.rollbackForUser(user, dto);
  }
}

@Controller("projects/:projectId/patch-executions")
@UseGuards(JwtAuthGuard)
export class ProjectPatchExecutionController {
  constructor(private readonly patchExecutionEngine: PatchExecutionEngineService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.patchExecutionEngine.listForProject(user, projectId);
  }
}

@Controller("memory")
@UseGuards(JwtAuthGuard)
export class ProductMemoryController {
  constructor(private readonly productMemory: ProductMemoryService) {}

  @Post("save")
  save(@CurrentUser() user: AuthenticatedUser, @Body() dto: SaveProductMemoryDto) {
    return this.productMemory.saveForUser(user, dto);
  }
}

@Controller("projects/:projectId/memory")
@UseGuards(JwtAuthGuard)
export class ProjectMemoryController {
  constructor(private readonly productMemory: ProductMemoryService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.productMemory.listForProject(user, projectId);
  }

  @Get("timeline")
  timeline(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.productMemory.timelineForProject(user, projectId);
  }
}

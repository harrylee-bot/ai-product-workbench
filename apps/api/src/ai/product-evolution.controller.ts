import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { EvolutionEngineService } from "./evolution-engine.service";
import { FeedbackAnalysisService } from "./feedback-analysis.service";
import { InteractionCaptureService } from "./interaction-capture.service";
import { MultiAgentReviewService } from "./multi-agent-review.service";
import { PatchExecutionEngineService } from "./patch-execution-engine.service";
import { ProductMemoryService } from "./product-memory.service";
import {
  AnalyzeFeedbackDto,
  ApplyEvolutionPlanDto,
  CreateInteractionDto,
  RollbackPatchDto,
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

@Controller("feedback")
@UseGuards(JwtAuthGuard)
export class FeedbackAnalysisController {
  constructor(private readonly feedbackAnalysis: FeedbackAnalysisService) {}

  @Post("analyze")
  analyze(@CurrentUser() user: AuthenticatedUser, @Body() dto: AnalyzeFeedbackDto) {
    return this.feedbackAnalysis.analyzeForUser(user, dto);
  }
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
  constructor(private readonly evolutionEngine: EvolutionEngineService) {}

  @Post("run")
  run(@CurrentUser() user: AuthenticatedUser, @Body() dto: RunProjectWorkflowDto) {
    return this.evolutionEngine.runForUser(user, dto);
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

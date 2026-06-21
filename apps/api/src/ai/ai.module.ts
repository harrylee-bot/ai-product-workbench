import { Module } from "@nestjs/common";
import { FileModule } from "../files/file.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { ModelGatewayModule } from "../model-gateway/model-gateway.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ProjectModule } from "../projects/project.module";
import { AgentRunLogService } from "./agent-run-log.service";
import { AiOrchestratorService } from "./ai-orchestrator.service";
import { EvolutionEngineService } from "./evolution-engine.service";
import { EvolutionOrchestratorService } from "./evolution-orchestrator.service";
import { FeedbackAnalysisService } from "./feedback-analysis.service";
import { InteractionCaptureService } from "./interaction-capture.service";
import { MultiAgentReviewService } from "./multi-agent-review.service";
import { PatchExecutionEngineService } from "./patch-execution-engine.service";
import { ProductMemoryService } from "./product-memory.service";
import { IntentAgentService } from "./agents/intent-agent.service";
import { KnowledgeAgentService } from "./agents/knowledge-agent.service";
import { KnowledgeExtractorAgentService } from "./agents/knowledge-extractor-agent.service";
import { PatchAgentService } from "./agents/patch-agent.service";
import { PrdWriterAgentService } from "./agents/prd-writer-agent.service";
import { ProductDesignerAgentService } from "./agents/product-designer-agent.service";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { QaAgentService } from "./agents/qa-agent.service";
import { RequirementAnalystAgentService } from "./agents/requirement-analyst-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";
import {
  ProductDesignStateResourceController,
  ProjectProductDesignStateController,
} from "./product-design-state.controller";
import {
  PatchDraftController,
  PatchResourceController,
  ProjectPatchController,
} from "./patch.controller";
import { PatchService } from "./patch.service";
import {
  PrdDocumentController,
  ProjectPrdController,
} from "./requirement-document.controller";
import { RequirementDocumentService } from "./requirement-document.service";
import {
  ProjectPrototypeController,
  PrototypeArtifactController,
  PrototypeStateController,
} from "./prototype.controller";
import { PrototypeService } from "./prototype.service";
import {
  ProjectQaController,
  ProjectQaReportsController,
  ProjectRollbackController,
  ProjectVersionTimelineController,
  QaReportController,
} from "./qa.controller";
import { QaRuleCheckService } from "./qa-rule-check.service";
import { QaService } from "./qa.service";
import { RollbackService } from "./rollback.service";
import { VersionHistoryService } from "./version-history.service";
import { VibeController } from "./vibe.controller";
import { VibeService } from "./vibe.service";
import { VibeStreamService } from "./vibe-stream.service";
import {
  InlineAssistantController,
  PrdEditingController,
  PrototypeEditingController,
} from "./editing.controller";
import {
  AiSuggestionController,
  EventController,
  EvolutionController,
  FeedbackAnalysisController,
  InteractionController,
  MultiAgentReviewController,
  PatchExecutionController,
  ProjectEvolutionController,
  ProjectInsightController,
  ProjectInteractionController,
  ProjectMemoryController,
  ProjectPatchExecutionController,
  ProjectReviewController,
  ProductMemoryController,
} from "./product-evolution.controller";

@Module({
  imports: [PrismaModule, ProjectModule, FileModule, KnowledgeModule, ModelGatewayModule],
  controllers: [
    VibeController,
    ProjectProductDesignStateController,
    ProductDesignStateResourceController,
    ProjectPatchController,
    PatchDraftController,
    PatchResourceController,
    ProjectPrdController,
    PrdDocumentController,
    ProjectPrototypeController,
    PrototypeStateController,
    PrototypeArtifactController,
    ProjectQaController,
    ProjectQaReportsController,
    QaReportController,
    ProjectVersionTimelineController,
    ProjectRollbackController,
    PrdEditingController,
    PrototypeEditingController,
    InlineAssistantController,
    InteractionController,
    ProjectInteractionController,
    EventController,
    AiSuggestionController,
    FeedbackAnalysisController,
    ProjectInsightController,
    MultiAgentReviewController,
    ProjectReviewController,
    EvolutionController,
    ProjectEvolutionController,
    PatchExecutionController,
    ProjectPatchExecutionController,
    ProductMemoryController,
    ProjectMemoryController,
  ],
  providers: [
    VibeService,
    AiOrchestratorService,
    AgentRunLogService,
    VibeStreamService,
    ProductDesignStateService,
    PatchService,
    RequirementDocumentService,
    PrototypeService,
    QaRuleCheckService,
    QaService,
    VersionHistoryService,
    RollbackService,
    InteractionCaptureService,
    FeedbackAnalysisService,
    MultiAgentReviewService,
    EvolutionEngineService,
    EvolutionOrchestratorService,
    PatchExecutionEngineService,
    ProductMemoryService,
    IntentAgentService,
    KnowledgeAgentService,
    RequirementAnalystAgentService,
    ProductDesignerAgentService,
    PrdWriterAgentService,
    PrototypeDesignerAgentService,
    PrototypeCodeAgentService,
    PatchAgentService,
    QaAgentService,
    KnowledgeExtractorAgentService,
  ],
})
export class AiModule {}

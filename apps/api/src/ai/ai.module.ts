import { Module } from "@nestjs/common";
import { ConstraintModule } from "../constraint/constraint.module";
import { FileModule } from "../files/file.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { ModelGatewayModule } from "../model-gateway/model-gateway.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MessageService } from "../projects/message.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { AgentSkillRegistryService } from "./agent-skill-registry.service";
import { AiOrchestratorService } from "./ai-orchestrator.service";
import { DocumentCanvasService } from "./document-canvas.service";
import { ProjectExportController } from "./export.controller";
import { ExportService } from "./export.service";
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
import { PatchPreviewController } from "./patch-builder/patch-preview.controller";
import { PatchPreviewService } from "./patch-builder/patch-preview.service";
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
import { ShareLinkController, PublicShareController } from "./share.controller";
import { ShareService } from "./share.service";
import { VibeService } from "./vibe.service";
import { VibeStreamService } from "./vibe-stream.service";
import {
  InlineAssistantController,
  PrdEditingController,
  PrototypeEditingController,
} from "./editing.controller";
import { ExternalRuntimeConfigService } from "./runtime/external-runtime-config.service";
import { ExternalRuntimeService } from "./runtime/external-runtime.service";
import { CodexRuntimeAdapter } from "./runtime/codex-runtime.adapter";
import { DeerFlowRuntimeAdapter } from "./runtime/deerflow-runtime.adapter";
import { ProductRuntimeService } from "./runtime/product-runtime.service";

@Module({
  imports: [PrismaModule, ConstraintModule, FileModule, KnowledgeModule, ModelGatewayModule],
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
    ProjectExportController,
    ProjectQaController,
    ProjectQaReportsController,
    QaReportController,
    ProjectVersionTimelineController,
    ProjectRollbackController,
    PrdEditingController,
    PrototypeEditingController,
    InlineAssistantController,
    PatchPreviewController,
    ShareLinkController,
    PublicShareController,
  ],
  providers: [
    VibeService,
    AiOrchestratorService,
    AgentSkillRegistryService,
    AgentRunLogService,
    VibeStreamService,
    ProductDesignStateService,
    PatchService,
    PatchPreviewService,
    DocumentCanvasService,
    RequirementDocumentService,
    PrototypeService,
    ExportService,
    QaRuleCheckService,
    QaService,
    VersionHistoryService,
    RollbackService,
    ExternalRuntimeConfigService,
    ExternalRuntimeService,
    CodexRuntimeAdapter,
    DeerFlowRuntimeAdapter,
    ProductRuntimeService,
    MessageService,
    ShareService,
  ],
  exports: [VibeService],
})
export class AiModule {}

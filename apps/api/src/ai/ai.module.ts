import { Module } from "@nestjs/common";
import { ConstraintModule } from "../constraint/constraint.module";
import { FileModule } from "../files/file.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MessageService } from "../projects/message.service";
import { RuntimeRunLogService } from "./runtime-run-log.service";
import { RuntimeSkillRegistryService } from "./runtime-skill-registry.service";
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

@Module({
  imports: [PrismaModule, ConstraintModule, FileModule, KnowledgeModule],
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
    RuntimeSkillRegistryService,
    RuntimeRunLogService,
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
    MessageService,
    ShareService,
  ],
  exports: [VibeService],
})
export class AiModule {}

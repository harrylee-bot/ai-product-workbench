import { Module } from "@nestjs/common";
import { ConstraintModule } from "../constraint/constraint.module";
import { FileModule } from "../files/file.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MessageService } from "../conversations/message.service";
import { RuntimeRunLogService } from "./runtime-run-log.service";
import { RuntimeModelPolicyService } from "./runtime-model-policy.service";
import { DocumentCanvasService } from "./document-canvas.service";
import { ConversationExportController } from "./export.controller";
import { ExportService } from "./export.service";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import {
  ConversationDesignStateResourceController,
  ConversationDesignStateController,
} from "./conversation-design-state.controller";
import {
  PrdDocumentController,
  ConversationPrdController,
} from "./requirement-document.controller";
import { RequirementDocumentService } from "./requirement-document.service";
import {
  ConversationPrototypeController,
  PrototypeArtifactController,
  PrototypeStateController,
} from "./prototype.controller";
import { PrototypeService } from "./prototype.service";
import {
  ConversationQaController,
  ConversationQaReportsController,
  ConversationRollbackController,
  ConversationVersionTimelineController,
  QaReportController,
} from "./qa.controller";
import { QaRuleCheckService } from "./qa-rule-check.service";
import { QaService } from "./qa.service";
import { RollbackService } from "./rollback.service";
import { VersionHistoryService } from "./version-history.service";
import { ShareLinkController, AuthenticatedShareController } from "./share.controller";
import { ShareService } from "./share.service";
import { DeerFlowRuntimeService } from "./deerflow-runtime.service";
import { ExternalResearchService } from "./external-research.service";
import { FinalActionApplierService } from "./final-action-applier.service";
import { ConversationModule } from "../modules/conversation/conversation.module";
import { AichatStreamController } from "./aichat/aichat-stream.controller";
import { AichatStreamService } from "./aichat/aichat-stream.service";

@Module({
  imports: [
    PrismaModule,
    ConstraintModule,
    FileModule,
    KnowledgeModule,
    ConversationModule,
  ],
  controllers: [
    ConversationDesignStateController,
    ConversationDesignStateResourceController,
    ConversationPrdController,
    PrdDocumentController,
    ConversationPrototypeController,
    PrototypeStateController,
    PrototypeArtifactController,
    ConversationExportController,
    ConversationQaController,
    ConversationQaReportsController,
    QaReportController,
    ConversationVersionTimelineController,
    ConversationRollbackController,
    ShareLinkController,
    AuthenticatedShareController,
    AichatStreamController,
  ],
  providers: [
    DeerFlowRuntimeService,
    ExternalResearchService,
    FinalActionApplierService,
    RuntimeRunLogService,
    RuntimeModelPolicyService,
    ConversationDesignStateService,
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
    AichatStreamService,
  ],
  exports: [
    MessageService,
    DeerFlowRuntimeService,
    ExternalResearchService,
    FinalActionApplierService,
    RuntimeRunLogService,
    RuntimeModelPolicyService,
  ],
})
export class AiModule {}

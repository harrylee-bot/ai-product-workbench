import { Module } from "@nestjs/common";
import { FileModule } from "../files/file.module";
import { ModelGatewayModule } from "../model-gateway/model-gateway.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ProjectModule } from "../projects/project.module";
import { AgentRunLogService } from "./agent-run-log.service";
import { AiOrchestratorService } from "./ai-orchestrator.service";
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
  PrdDocumentController,
  ProjectPrdController,
} from "./requirement-document.controller";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeController } from "./vibe.controller";
import { VibeService } from "./vibe.service";
import { VibeStreamService } from "./vibe-stream.service";

@Module({
  imports: [PrismaModule, ProjectModule, FileModule, ModelGatewayModule],
  controllers: [
    VibeController,
    ProjectProductDesignStateController,
    ProductDesignStateResourceController,
    ProjectPrdController,
    PrdDocumentController,
  ],
  providers: [
    VibeService,
    AiOrchestratorService,
    AgentRunLogService,
    VibeStreamService,
    ProductDesignStateService,
    RequirementDocumentService,
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

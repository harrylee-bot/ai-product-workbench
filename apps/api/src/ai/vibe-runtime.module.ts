import { Module } from "@nestjs/common";
import { FileModule } from "../files/file.module";
import { KnowledgeModule } from "../knowledge/knowledge.module";
import { ModelGatewayModule } from "../model-gateway/model-gateway.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MessageService } from "../projects/message.service";
import { AgentRunLogService } from "./agent-run-log.service";
import { AgentSkillRegistryService } from "./agent-skill-registry.service";
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
import { PrototypeService } from "./prototype.service";
import { QaRuleCheckService } from "./qa-rule-check.service";
import { QaService } from "./qa.service";
import { RequirementDocumentService } from "./requirement-document.service";
import { VibeController } from "./vibe.controller";
import { VibeService } from "./vibe.service";
import { VibeStreamService } from "./vibe-stream.service";

@Module({
  imports: [PrismaModule, FileModule, KnowledgeModule, ModelGatewayModule],
  controllers: [VibeController],
  providers: [
    VibeService,
    AiOrchestratorService,
    AgentSkillRegistryService,
    AgentRunLogService,
    VibeStreamService,
    ProductDesignStateService,
    RequirementDocumentService,
    PrototypeService,
    QaRuleCheckService,
    QaService,
    MessageService,
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
export class VibeRuntimeModule {}

import { Module } from "@nestjs/common";
import { CompanyModule } from "../../company/company.module";
import { ConstraintModule } from "../../constraint/constraint.module";
import { FusionDecisionModule } from "../../decision/decision.module";
import { FusionEvolutionModule } from "../../evolution/evolution.module";
import { DecisionEngineService } from "../../ai/decision-engine/decision-engine.service";
import { DecisionTraceService } from "../../ai/evolution-engine/decision-trace.service";
import { EvolutionEngineService } from "../../ai/evolution-engine/evolution.engine.service";
import { PolicyUpdater } from "../../ai/evolution-engine/policy.updater";
import { SignalGenerator } from "../../ai/evolution-engine/signal.generator";
import { PatchBuilderService } from "../../ai/patch-builder/patch-builder.service";
import { PatchPreviewController } from "../../ai/patch-builder/patch-preview.controller";
import { PatchPreviewService } from "../../ai/patch-builder/patch-preview.service";
import { ReviewBoardService } from "../../ai/review-board/review-board.service";
import { AgentFactory } from "../../ai/self-generation/agent.factory";
import { MutationEngine } from "../../ai/self-generation/mutation.engine";
import { SelfGenerationEngine } from "../../ai/self-generation/self-generation.engine";
import { SystemGraphService } from "../../ai/self-generation/system.graph.service";
import { SystemMutationController } from "../../ai/self-generation/system-mutation.controller";
import { SystemPreviewService } from "../../ai/self-generation/system.preview.service";
import { StrategySelectorService } from "../../ai/strategy-selector/strategy-selector.service";
import { PrismaModule } from "../../prisma/prisma.module";
import { IntentAgent } from "./agents/intent/intent.agent";
import { OrchestratorController } from "./orchestrator/orchestrator.controller";
import { OrchestratorService } from "./orchestrator/orchestrator.service";

@Module({
  imports: [PrismaModule, CompanyModule, ConstraintModule, FusionDecisionModule, FusionEvolutionModule],
  controllers: [OrchestratorController, PatchPreviewController, SystemMutationController],
  providers: [
    OrchestratorService,
    IntentAgent,
    DecisionEngineService,
    DecisionTraceService,
    EvolutionEngineService,
    SignalGenerator,
    PolicyUpdater,
    ReviewBoardService,
    StrategySelectorService,
    PatchBuilderService,
    PatchPreviewService,
    AgentFactory,
    SelfGenerationEngine,
    SystemGraphService,
    MutationEngine,
    SystemPreviewService,
  ],
  exports: [OrchestratorService],
})
export class AiModule {}

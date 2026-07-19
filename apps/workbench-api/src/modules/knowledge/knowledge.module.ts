import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { KnowledgeRetrievalConfig } from "./knowledge-retrieval.config.js";
import { KnowledgeReadinessService } from "./knowledge-readiness.service.js";
import { KnowledgeProfilesController } from "./knowledge-profiles.controller.js";
import { KnowledgeProfilesService } from "./knowledge-profiles.service.js";
import { KnowledgeToolController } from "./knowledge-tool.controller.js";
import { KnowledgeToolLedgerService } from "./knowledge-tool-ledger.service.js";
import { KnowledgeToolService } from "./knowledge-tool.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [KnowledgeProfilesController, KnowledgeToolController],
  providers: [
    KnowledgeProfilesService,
    KnowledgeRetrievalConfig,
    KnowledgeReadinessService,
    KnowledgeToolLedgerService,
    KnowledgeToolService,
  ],
  exports: [KnowledgeReadinessService],
})
export class KnowledgeModule {}

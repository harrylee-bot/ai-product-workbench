import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeAdminController } from "./knowledge-admin.controller";
import { KnowledgeCandidateService } from "./knowledge-candidate.service";
import { KnowledgeItemService } from "./knowledge-item.service";
import { KnowledgeRetrievalService } from "./knowledge-retrieval.service";
import { ObsidianVaultService } from "./obsidian-vault.service";

@Module({
  imports: [AdminModule, PrismaModule],
  controllers: [KnowledgeAdminController],
  providers: [
    KnowledgeItemService,
    KnowledgeCandidateService,
    KnowledgeRetrievalService,
    ObsidianVaultService,
  ],
  exports: [KnowledgeCandidateService, KnowledgeRetrievalService],
})
export class KnowledgeModule {}

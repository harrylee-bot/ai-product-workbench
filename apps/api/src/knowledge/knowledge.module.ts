import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeAdminController } from "./knowledge-admin.controller";
import { KnowledgeCandidateService } from "./knowledge-candidate.service";
import { KnowledgeItemService } from "./knowledge-item.service";
import { KnowledgeRetrievalService } from "./knowledge-retrieval.service";

@Module({
  imports: [AdminModule, PrismaModule],
  controllers: [KnowledgeAdminController],
  providers: [
    KnowledgeItemService,
    KnowledgeCandidateService,
    KnowledgeRetrievalService,
  ],
  exports: [KnowledgeCandidateService, KnowledgeRetrievalService],
})
export class KnowledgeModule {}

import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { KnowledgeAdminController } from "./knowledge-admin.controller";
import { KnowledgeCandidateService } from "./knowledge-candidate.service";
import { KnowledgeItemService } from "./knowledge-item.service";
import { KnowledgeRetrievalService } from "./knowledge-retrieval.service";

@Module({
  imports: [PrismaModule],
  controllers: [KnowledgeAdminController],
  providers: [
    KnowledgeItemService,
    KnowledgeCandidateService,
    KnowledgeRetrievalService,
  ],
  exports: [KnowledgeCandidateService, KnowledgeRetrievalService],
})
export class KnowledgeModule {}

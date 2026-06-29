import { Module } from "@nestjs/common";
import { ConversationModule } from "../../modules/conversation/conversation.module";
import { KnowledgeModule } from "../../knowledge/knowledge.module";
import { AiModule } from "../ai.module";
import { AichatStreamController } from "./aichat-stream.controller";
import { AichatStreamService } from "./aichat-stream.service";

/**
 * AI-SDK UIMessageStream 桥模块。
 *
 * 依赖：
 * - ConversationService（ConversationModule 导出）
 * - MessageService + DeerFlowRuntimeService + FinalActionApplierService + RuntimeRunLogService
 *   （AiModule 提供；其中后三者需 AiModule 显式 export，见 sharedFileEdits）
 * - KnowledgeRetrievalService（KnowledgeModule 导出）
 *
 * 本模块挂 AichatStreamController，由 AiModule 导入注册到 /api/chat。
 */
@Module({
  imports: [AiModule, ConversationModule, KnowledgeModule],
  controllers: [AichatStreamController],
  providers: [AichatStreamService],
  exports: [],
})
export class AichatModule {}

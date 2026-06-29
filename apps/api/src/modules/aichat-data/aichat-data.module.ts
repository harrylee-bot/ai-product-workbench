import { Module } from "@nestjs/common";
import { AichatDataController } from "./aichat-data.controller";
import { AichatDataService } from "./aichat-data.service";

/**
 * ai-chatbot 持久化数据端点模块。
 *
 * 仅依赖 PrismaService（全局模块，无需显式 import）。
 * 提供：会话重命名、批量写消息、消息 parts 编辑、按时间截断消息、
 * 用户消息计数、投票、建议、stream id 记录。
 */
@Module({
  controllers: [AichatDataController],
  providers: [AichatDataService],
})
export class AichatDataModule {}

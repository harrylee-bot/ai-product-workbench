import { Module } from "@nestjs/common";
import { AiModule } from "../../ai/ai.module";
import { PrismaModule } from "../../prisma/prisma.module";
import { MessageController } from "./message.controller";

@Module({
  // AiModule 导出 VibeService 与 projects/MessageService；本模块只挂控制器，不再自带重复 service。
  imports: [PrismaModule, AiModule],
  controllers: [MessageController],
})
export class MessageModule {}

import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AiModule } from "../ai/ai.module";
import { MessageController } from "./message.controller";
import { MessageService } from "./message.service";

@Module({
  imports: [PrismaModule, AiModule],
  controllers: [MessageController],
  providers: [MessageService],
})
export class MessageModule {}

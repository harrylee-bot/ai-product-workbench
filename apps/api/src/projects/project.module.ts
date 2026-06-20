import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ConversationController } from "./conversation.controller";
import { MessageController } from "./message.controller";
import { MessageService } from "./message.service";
import { ProjectController } from "./project.controller";
import { ProjectService } from "./project.service";

@Module({
  imports: [PrismaModule],
  controllers: [ProjectController, ConversationController, MessageController],
  providers: [ProjectService, MessageService],
  exports: [ProjectService, MessageService],
})
export class ProjectModule {}

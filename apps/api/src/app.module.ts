import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AdminModule } from "./admin/admin.module";
import { ConstraintModule } from "./constraint/constraint.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ModelGatewayModule } from "./model-gateway/model-gateway.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ConversationModule } from "./modules/conversation/conversation.module";
import { MessageModule } from "./modules/message/message.module";
import { ProjectModule } from "./modules/project/project.module";
import { SystemModule } from "./modules/system/system.module";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
    }),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminUsersModule,
    KnowledgeModule,
    ModelGatewayModule,
    ProjectModule,
    ConversationModule,
    MessageModule,
    ConstraintModule,
    AiModule,
    SystemModule,
  ],
})
export class AppModule {}

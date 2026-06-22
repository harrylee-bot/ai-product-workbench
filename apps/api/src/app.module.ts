import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AdminModule } from "./admin/admin.module";
import { CompanyModule } from "./company/company.module";
import { ConstraintModule } from "./constraint/constraint.module";
import { FusionDecisionModule } from "./decision/decision.module";
import { FusionEvolutionModule } from "./evolution/evolution.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ModelGatewayModule } from "./model-gateway/model-gateway.module";
import { VibeRuntimeModule } from "./ai/vibe-runtime.module";
import { AiModule as LegacyAiModule } from "./modules/ai/ai.module";
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
    FusionDecisionModule,
    FusionEvolutionModule,
    CompanyModule,
    LegacyAiModule,
    VibeRuntimeModule,
    SystemModule,
  ],
})
export class AppModule {}

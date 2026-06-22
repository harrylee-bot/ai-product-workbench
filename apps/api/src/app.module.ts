import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CompanyModule } from "./company/company.module";
import { ConstraintModule } from "./constraint/constraint.module";
import { FusionDecisionModule } from "./decision/decision.module";
import { FusionEvolutionModule } from "./evolution/evolution.module";
import { AiModule } from "./modules/ai/ai.module";
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
    ProjectModule,
    ConversationModule,
    MessageModule,
    ConstraintModule,
    FusionDecisionModule,
    FusionEvolutionModule,
    CompanyModule,
    AiModule,
    SystemModule,
  ],
})
export class AppModule {}

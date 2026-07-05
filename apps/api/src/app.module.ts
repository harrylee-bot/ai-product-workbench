import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AdminModule } from "./admin/admin.module";
import { ConstraintModule } from "./constraint/constraint.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ModelGatewayModule } from "./model-gateway/model-gateway.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { ConversationModule } from "./modules/conversation/conversation.module";
import { MessageModule } from "./modules/message/message.module";
import { AichatDataModule } from "./modules/aichat-data/aichat-data.module";
import { SystemModule } from "./modules/system/system.module";
import { PrismaModule } from "./prisma/prisma.module";
import { CommentModule } from "./comments/comment.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
    }),
    // sec-3：全局默认限流。高风险接口直接用 @Throttle({ default }) 局部收紧，
    // 避免多个 named throttler 被框架套到所有路由上，误伤长时间聊天轮询。
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 60 },
    ]),
    PrismaModule,
    AuthModule,
    AdminModule,
    AdminUsersModule,
    KnowledgeModule,
    ModelGatewayModule,
    ConversationModule,
    MessageModule,
    AichatDataModule,
    ConstraintModule,
    AiModule,
    SystemModule,
    CommentModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}

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
    // sec-3：全局限流（默认每分钟 60 次/IP），登录/登录后分享接口另设更严格配额。
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 60 },
      { name: "auth", ttl: 60_000, limit: 10 },
      { name: "share", ttl: 60_000, limit: 30 },
      { name: "heavy", ttl: 60_000, limit: 10 },
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

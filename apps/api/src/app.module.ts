import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminModule } from "./admin/admin.module";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { FileModule } from "./files/file.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { ModelGatewayModule } from "./model-gateway/model-gateway.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProjectModule } from "./projects/project.module";
import { SystemModule } from "./system/system.module";

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
    ProjectModule,
    FileModule,
    KnowledgeModule,
    ModelGatewayModule,
    AiModule,
    SystemModule,
  ],
})
export class AppModule {}

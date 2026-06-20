import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ProjectModule } from "./projects/project.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
    }),
    PrismaModule,
    AuthModule,
    AdminUsersModule,
    ProjectModule,
    AiModule,
  ],
})
export class AppModule {}

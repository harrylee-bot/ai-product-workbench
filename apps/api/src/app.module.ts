import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminUsersModule } from "./admin-users/admin-users.module";
import { AiModule } from "./ai/ai.module";
import { AuthModule } from "./auth/auth.module";
import { FileModule } from "./files/file.module";
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
    AdminUsersModule,
    ProjectModule,
    FileModule,
    AiModule,
    SystemModule,
  ],
})
export class AppModule {}

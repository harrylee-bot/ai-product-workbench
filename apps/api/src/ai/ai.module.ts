import { Module } from "@nestjs/common";
import { FileModule } from "../files/file.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ProjectModule } from "../projects/project.module";
import { VibeController } from "./vibe.controller";
import { VibeService } from "./vibe.service";

@Module({
  imports: [PrismaModule, ProjectModule, FileModule],
  controllers: [VibeController],
  providers: [VibeService],
})
export class AiModule {}

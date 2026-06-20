import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ProjectModule } from "../projects/project.module";
import { VibeController } from "./vibe.controller";
import { VibeService } from "./vibe.service";

@Module({
  imports: [PrismaModule, ProjectModule],
  controllers: [VibeController],
  providers: [VibeService],
})
export class AiModule {}

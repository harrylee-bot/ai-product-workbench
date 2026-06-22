import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { FusionEvolutionController } from "./evolution.controller";
import { FusionEvolutionService } from "./evolution.service";

@Module({
  imports: [PrismaModule],
  controllers: [FusionEvolutionController],
  providers: [FusionEvolutionService],
  exports: [FusionEvolutionService],
})
export class FusionEvolutionModule {}

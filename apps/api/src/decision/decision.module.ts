import { Module } from "@nestjs/common";
import { ConstraintModule } from "../constraint/constraint.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FusionDecisionController } from "./decision.controller";
import { FusionDecisionService } from "./decision.service";

@Module({
  imports: [PrismaModule, ConstraintModule],
  controllers: [FusionDecisionController],
  providers: [FusionDecisionService],
  exports: [FusionDecisionService],
})
export class FusionDecisionModule {}

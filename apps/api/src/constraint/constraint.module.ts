import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ConstraintController } from "./constraint.controller";
import { ConstraintService } from "./constraint.service";

@Module({
  imports: [PrismaModule],
  controllers: [ConstraintController],
  providers: [ConstraintService],
  exports: [ConstraintService],
})
export class ConstraintModule {}

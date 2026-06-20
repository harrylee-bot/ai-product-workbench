import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuditService } from "./admin-audit.service";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminModule {}

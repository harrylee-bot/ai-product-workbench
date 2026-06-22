import { Module } from "@nestjs/common";
import { RolesGuard } from "../auth/roles.guard";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminAuditService } from "./admin-audit.service";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [PrismaModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAuditService, RolesGuard],
  exports: [AdminAuditService, RolesGuard],
})
export class AdminModule {}

import { Module } from "@nestjs/common";
import { RolesGuard } from "../auth/roles.guard";
import { FileModule } from "../files/file.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AdminDeerflowController } from "./admin-deerflow.controller";
import { AdminDeerflowService } from "./admin-deerflow.service";
import { AdminAuditService } from "./admin-audit.service";
import { AdminController } from "./admin.controller";
import { AdminService } from "./admin.service";

@Module({
  imports: [PrismaModule, FileModule],
  controllers: [AdminController, AdminDeerflowController],
  providers: [AdminService, AdminDeerflowService, AdminAuditService, RolesGuard],
  exports: [AdminAuditService, RolesGuard],
})
export class AdminModule {}

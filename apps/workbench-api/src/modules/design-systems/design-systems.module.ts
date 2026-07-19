import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { DesignSystemImportsController } from "./design-system-imports.controller.js";
import { DesignSystemImportsService } from "./design-system-imports.service.js";
import { DesignSystemCatalogService } from "./design-system-catalog.service.js";
import { DesignSystemsService } from "./design-systems.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [DesignSystemImportsController],
  providers: [DesignSystemCatalogService, DesignSystemImportsService, DesignSystemsService],
  exports: [DesignSystemCatalogService, DesignSystemImportsService, DesignSystemsService],
})
export class DesignSystemsModule {}

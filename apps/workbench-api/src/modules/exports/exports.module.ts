import { Module } from "@nestjs/common";
import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ExportsController } from "./exports.controller.js";
import { ExportCapabilitiesConfig } from "./export-capabilities.config.js";
import { ExportPreviewConfig } from "./export-preview.config.js";
import { ExportsService } from "./exports.service.js";
import { ExternalExportDeliveriesService } from "./external-export-deliveries.service.js";

@Module({
  imports: [AccessModule, IdentityModule, ObjectStorageModule],
  controllers: [ExportsController],
  providers: [ExportCapabilitiesConfig, ExportPreviewConfig, ExportsService, ExternalExportDeliveriesService],
})
export class ExportsModule {}

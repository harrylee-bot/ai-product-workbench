import { Module } from "@nestjs/common";
import { ArtifactsModule } from "../artifacts/artifacts.module.js";
import { SharesModule } from "../shares/shares.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ExportPreviewConfig } from "../exports/export-preview.config.js";
import { SourcePrototypePreviewController, PublicSourcePrototypePreviewController } from "./source-prototype-preview.controller.js";
import { SourcePrototypePreviewService } from "./source-prototype-preview.service.js";

@Module({
  imports: [ArtifactsModule, SharesModule, IdentityModule],
  controllers: [SourcePrototypePreviewController, PublicSourcePrototypePreviewController],
  providers: [ExportPreviewConfig, SourcePrototypePreviewService],
})
export class SourcePrototypePreviewModule {}

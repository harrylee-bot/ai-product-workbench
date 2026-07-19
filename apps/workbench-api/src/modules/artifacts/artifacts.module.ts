import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { ArtifactVersionPreferencesController } from "./artifact-version-preferences.controller.js";
import { ArtifactVersionPreferencesService } from "./artifact-version-preferences.service.js";
import { ArtifactsController } from "./artifacts.controller.js";
import { ArtifactsService } from "./artifacts.service.js";

@Module({
  imports: [AccessModule, IdentityModule, ObjectStorageModule],
  controllers: [ArtifactsController, ArtifactVersionPreferencesController],
  providers: [ArtifactsService, ArtifactVersionPreferencesService],
})
export class ArtifactsModule {}

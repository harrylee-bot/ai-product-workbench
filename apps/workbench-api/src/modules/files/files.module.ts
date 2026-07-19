import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { FileApiConfig } from "./file-api.config.js";
import { FileUploadsService } from "./file-uploads.service.js";
import { FilesController } from "./files.controller.js";
import { FilesService } from "./files.service.js";

@Module({
  imports: [IdentityModule, ObjectStorageModule],
  controllers: [FilesController],
  providers: [
    FileApiConfig,
    FilesService,
    FileUploadsService,
  ],
  exports: [FilesService, FileUploadsService],
})
export class FilesModule {}

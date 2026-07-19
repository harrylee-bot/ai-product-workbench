import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ImportSourcesController } from "./import-sources.controller.js";
import { ImportSourcesService } from "./import-sources.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [ImportSourcesController],
  providers: [ImportSourcesService],
  exports: [ImportSourcesService],
})
export class ImportSourcesModule {}

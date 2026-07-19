import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { ReleasesController } from "./releases.controller.js";
import { ReleasesService } from "./releases.service.js";

@Module({
  imports: [AccessModule, IdentityModule],
  controllers: [ReleasesController],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}

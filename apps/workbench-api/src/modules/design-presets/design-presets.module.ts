import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { DesignPresetsController } from "./design-presets.controller.js";
import { DesignPresetsService } from "./design-presets.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [DesignPresetsController],
  providers: [DesignPresetsService],
  exports: [DesignPresetsService],
})
export class DesignPresetsModule {}

import { Controller, Get, UseGuards } from "@nestjs/common";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { DesignPresetsService } from "./design-presets.service.js";

@Controller("design-presets")
@UseGuards(WorkbenchAuthGuard)
export class DesignPresetsController {
  constructor(private readonly designPresets: DesignPresetsService) {}

  @Get()
  list() {
    return this.designPresets.list();
  }
}

import { Controller, Get, UseGuards } from "@nestjs/common";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { RuntimeModelsService } from "./runtime-models.service.js";

@Controller("runtime")
@UseGuards(WorkbenchAuthGuard)
export class RuntimeModelsController {
  constructor(private readonly models: RuntimeModelsService) {}

  @Get("models")
  list() {
    return this.models.list();
  }
}

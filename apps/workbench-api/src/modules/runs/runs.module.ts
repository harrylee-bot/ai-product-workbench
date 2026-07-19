import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { DesignPresetsModule } from "../design-presets/design-presets.module.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { RunEventStore } from "./run-event.store.js";
import { RunApprovalsController } from "./run-approvals.controller.js";
import { RunApprovalsService } from "./run-approvals.service.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

@Module({
  imports: [AccessModule, DesignPresetsModule, IdentityModule, RuntimeModule],
  controllers: [RunsController, RunApprovalsController],
  providers: [RunEventStore, RunApprovalsService, RunsService],
  exports: [RunEventStore, RunsService],
})
export class RunsModule {}

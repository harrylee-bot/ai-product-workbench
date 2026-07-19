import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { DeerFlowRuntimeReadinessService } from "./deerflow-runtime-readiness.service.js";
import { RuntimeModelsController } from "./runtime-models.controller.js";
import { RuntimeModelsService } from "./runtime-models.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [RuntimeModelsController],
  providers: [DeerFlowRuntimeReadinessService, RuntimeModelsService],
  exports: [DeerFlowRuntimeReadinessService, RuntimeModelsService],
})
export class RuntimeModule {}

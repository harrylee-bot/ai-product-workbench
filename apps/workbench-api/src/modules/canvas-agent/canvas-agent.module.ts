import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { CanvasAgentConfig } from "./canvas-agent.config.js";
import { CanvasAgentController } from "./canvas-agent.controller.js";
import { CanvasAgentExpiryReconciler } from "./canvas-agent-expiry-reconciler.js";
import { CanvasAgentService } from "./canvas-agent.service.js";

@Module({
  imports: [IdentityModule, ObjectStorageModule],
  controllers: [CanvasAgentController],
  providers: [CanvasAgentConfig, CanvasAgentExpiryReconciler, CanvasAgentService],
  exports: [CanvasAgentService],
})
export class CanvasAgentModule {}

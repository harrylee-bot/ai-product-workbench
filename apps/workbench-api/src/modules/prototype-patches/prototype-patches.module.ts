import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PrototypePatchCheckpointsController } from "./prototype-patch-checkpoints.controller.js";
import { PrototypePatchCheckpointsService } from "./prototype-patch-checkpoints.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [PrototypePatchCheckpointsController],
  providers: [PrototypePatchCheckpointsService],
})
export class PrototypePatchesModule {}

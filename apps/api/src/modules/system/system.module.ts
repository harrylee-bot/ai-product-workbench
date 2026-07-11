import { Module } from "@nestjs/common";
import { SystemController } from "./system.controller";
import { SystemProbeController } from "./system-probe.controller";
import { SystemReadinessService } from "./system-readiness.service";

@Module({
  controllers: [SystemController, SystemProbeController],
  providers: [SystemReadinessService],
})
export class SystemModule {}

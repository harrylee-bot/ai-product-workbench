import { Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { shutdownTelemetry } from "@workbench/workbench-telemetry";

@Injectable()
class WorkbenchTelemetryLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await shutdownTelemetry();
  }
}

@Module({ providers: [WorkbenchTelemetryLifecycle] })
export class WorkbenchTelemetryModule {}

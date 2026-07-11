import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { SystemReadinessService } from "./system-readiness.service";

@Controller()
export class SystemProbeController {
  constructor(private readonly readiness: SystemReadinessService) {}

  @Get(["live", "system/live"])
  live() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      checkedAt: new Date().toISOString(),
    };
  }

  @Get(["ready", "system/ready"])
  async ready(@Res({ passthrough: true }) response: Response) {
    const report = await this.readiness.check();
    if (!report.ok) {
      response.status(503);
    }
    return report;
  }
}

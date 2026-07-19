import { Controller, Get } from "@nestjs/common";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { KnowledgeReadinessService } from "../knowledge/knowledge-readiness.service.js";
import { DeerFlowRuntimeReadinessService } from "../runtime/deerflow-runtime-readiness.service.js";

@Controller("system")
export class SystemController {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly runtime: DeerFlowRuntimeReadinessService,
    private readonly knowledge: KnowledgeReadinessService,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    await Promise.all([
      this.db.$queryRaw`SELECT 1`,
      this.runtime.assertReady(),
      this.knowledge.assertReady(),
    ]);
    return { status: "ready" };
  }
}

import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      deerflow: {
        // 使命关键开关：DEERFLOW_ENABLED=false 时自然语言→PRD→原型链路断开。
        // 部署监控应据此告警。
        enabled: process.env.DEERFLOW_ENABLED === "true",
      },
      modules: [
        "auth",
        "admin-dashboard",
        "admin-users",
        "admin-audit",
        "knowledge-base",
        "obsidian-vault",
        "model-gateway",
        "projects",
        "conversations",
        "messages",
        "ai-vibe",
        "ai-vibe-stream",
        "constraint-system",
        "product-design-state",
        "requirement-documents",
        "prototype-artifacts",
        "qa-reports",
        "version-timeline",
        "rollback-records",
      ],
    };
  }
}

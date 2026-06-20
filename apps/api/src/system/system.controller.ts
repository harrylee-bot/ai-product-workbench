import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      modules: [
        "auth",
        "admin-users",
        "projects",
        "files",
        "model-gateway",
        "ai-vibe",
        "product-design-state",
        "requirement-documents",
        "prototype-artifacts",
        "patch-records",
        "knowledge-base",
        "admin-dashboard",
        "admin-logs",
        "admin-audit",
        "qa-reports",
        "version-timeline",
        "rollback-records",
        "prd-editing",
        "prototype-editing",
        "inline-assistant",
        "interaction-capture",
        "semantic-feedback-analyzer",
        "multi-agent-review",
        "evolution-engine",
        "patch-execution-engine",
      ],
    };
  }
}

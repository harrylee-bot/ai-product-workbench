import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "vibe-runtime-adapter",
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
        "obsidian-agent-skills",
        "admin-dashboard",
        "admin-logs",
        "admin-audit",
        "qa-reports",
        "version-timeline",
        "rollback-records",
        "prd-editing",
        "prototype-editing",
        "inline-assistant",
        "runtime-adapters",
        "codex-runtime-adapter",
        "deerflow-runtime-adapter",
        "product-runtime-service",
        "constraint-system",
      ],
    };
  }
}

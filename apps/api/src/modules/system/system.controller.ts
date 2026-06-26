import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      modules: [
        "auth",
        "admin-dashboard",
        "admin-users",
        "admin-audit",
        "knowledge-base",
        "obsidian-vault",
        "codex-runtime-skills",
        "model-gateway",
        "projects",
        "conversations",
        "messages",
        "ai-vibe",
        "ai-vibe-stream",
        "runtime-adapters",
        "codex-runtime-adapter",
        "deerflow-runtime-adapter",
        "product-runtime-service",
        "constraint-system",
        "patch-builder",
        "patch-preview",
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

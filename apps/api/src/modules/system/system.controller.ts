import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "triple-system-fusion-ai-product-os",
      modules: [
        "auth",
        "projects",
        "conversations",
        "messages",
        "orchestrator",
        "constraint-system",
        "fusion-decision-system",
        "fusion-evolution-system",
        "intent-agent",
        "decision-engine",
        "review-board",
        "strategy-selector",
        "patch-builder",
        "patch-preview",
        "evolution-engine",
        "system-policy",
        "self-generation-engine",
        "system-graph",
        "mutation-pipeline",
        "system-preview",
        "company-runtime",
        "ceo-layer",
        "product-department",
        "engineering-department",
        "design-department",
        "qa-department",
        "growth-department",
        "evolution-department",
      ],
    };
  }
}

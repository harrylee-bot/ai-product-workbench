import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    const modelName =
      readEnv("DEERFLOW_MODEL_NAME") ??
      readEnv("DEFAULT_MODEL_NAME") ??
      "deerflow-runtime";
    const modelDisplayName = readEnv("DEERFLOW_MODEL_DISPLAY_NAME") ?? modelName;
    const runtimeName = readEnv("DEERFLOW_AGENT_NAME") ?? "lead_agent";
    const provider = readEnv("DEERFLOW_MODEL_PROVIDER") ?? "deerflow";

    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      deerflow: {
        // 使命关键开关：DEERFLOW_ENABLED=false 时自然语言→PRD→原型链路断开。
        // 部署监控应据此告警。
        enabled: process.env.DEERFLOW_ENABLED === "true",
        modelId: `${provider}/${modelName}`,
        modelName,
        modelDisplayName,
        runtimeName,
        provider,
      },
      modules: [
        "auth",
        "admin-dashboard",
        "admin-users",
        "admin-audit",
        "knowledge-base",
        "obsidian-vault",
        "model-gateway",
        "conversations",
        "messages",
        "ai-vibe",
        "ai-vibe-stream",
        "constraint-system",
        "conversation-design-state",
        "requirement-documents",
        "prototype-artifacts",
        "qa-reports",
        "version-timeline",
        "rollback-records",
      ],
    };
  }
}

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

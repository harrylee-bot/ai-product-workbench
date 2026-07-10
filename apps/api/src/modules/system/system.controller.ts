import { Controller, Get } from "@nestjs/common";
import { buildRuntimeModelOptions } from "../../common/runtime-model-config";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    const models = buildRuntimeModelOptions();
    const defaultModel = models[0];
    const modelName = modelNameFromModelId(defaultModel.id);
    const modelDisplayName = defaultModel.name;
    const runtimeName = readEnv("DEERFLOW_AGENT_NAME") ?? "lead_agent";
    const provider = defaultModel.provider;
    const commitSha = readEnv("APP_BUILD_SHA") ?? "unknown";

    return {
      ok: true,
      service: "ai-product-workbench-api",
      phase: "deerflow-first-runtime",
      build: { commitSha },
      deerflow: {
        // 使命关键开关：DEERFLOW_ENABLED=false 时自然语言→PRD→原型链路断开。
        // 部署监控应据此告警。
        enabled: process.env.DEERFLOW_ENABLED === "true",
        modelId: defaultModel.id,
        modelName,
        modelDisplayName,
        runtimeName,
        provider,
        models,
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

function modelNameFromModelId(modelId: string) {
  const separatorIndex = modelId.indexOf("/");
  return separatorIndex >= 0 ? modelId.slice(separatorIndex + 1) : modelId;
}

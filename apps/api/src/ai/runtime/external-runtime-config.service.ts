import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { join } from "node:path";
import type { RuntimeProvider } from "./external-runtime.types";

@Injectable()
export class ExternalRuntimeConfigService {
  constructor(private readonly config: ConfigService) {}

  prototypeCodeProvider(): RuntimeProvider {
    return normalizeProvider(this.config.get<string>("VIBE_PROTOTYPE_CODE_RUNTIME"), "local");
  }

  prototypeSpecProvider(): RuntimeProvider {
    return normalizeProvider(this.config.get<string>("VIBE_PROTOTYPE_SPEC_RUNTIME"), "local");
  }

  patchPlanProvider(): RuntimeProvider {
    return normalizeProvider(this.config.get<string>("VIBE_PATCH_PLAN_RUNTIME"), "local");
  }

  qaProvider(): RuntimeProvider {
    return normalizeProvider(this.config.get<string>("VIBE_QA_RUNTIME"), "local");
  }

  requirementProvider(): RuntimeProvider {
    return normalizeProvider(this.config.get<string>("VIBE_REQUIREMENT_RUNTIME"), "local");
  }

  runtimeFallbackToLocal(): boolean {
    return this.config.get<string>("VIBE_RUNTIME_FALLBACK_TO_LOCAL")?.trim().toLowerCase() !== "false";
  }

  workspaceRoot() {
    return this.config.get<string>("VIBE_RUNTIME_WORKSPACE_ROOT")?.trim()
      || join(process.cwd(), ".vibe-runtime-workspaces");
  }

  codexCommand() {
    return this.config.get<string>("VIBE_CODEX_COMMAND")?.trim() || "codex";
  }

  codexSandbox() {
    const value = this.config.get<string>("VIBE_CODEX_SANDBOX")?.trim();
    if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
    return "workspace-write";
  }

  codexModelProviderId() {
    return safeProviderId(this.config.get<string>("CODEX_MODEL_PROVIDER_ID")?.trim() || "vibe_openai_compatible");
  }

  codexModelProviderName() {
    return this.config.get<string>("CODEX_MODEL_PROVIDER_NAME")?.trim()
      || this.config.get<string>("DEFAULT_MODEL_PROVIDER_NAME")?.trim()
      || "Vibe OpenAI Compatible";
  }

  codexBaseUrl() {
    return this.config.get<string>("CODEX_BASE_URL")?.trim()
      || this.config.get<string>("OPENAI_BASE_URL")?.trim()
      || this.config.get<string>("DEFAULT_MODEL_BASE_URL")?.trim();
  }

  codexModel() {
    return this.config.get<string>("CODEX_MODEL")?.trim()
      || this.config.get<string>("OPENAI_MODEL")?.trim()
      || this.config.get<string>("DEFAULT_MODEL_NAME")?.trim();
  }

  codexApiKey() {
    return this.config.get<string>("CODEX_API_KEY")?.trim()
      || this.config.get<string>("OPENAI_API_KEY")?.trim()
      || this.config.get<string>("DEFAULT_MODEL_API_KEY")?.trim();
  }

  codexSupportsWebsockets(): boolean {
    return this.config.get<string>("CODEX_SUPPORTS_WEBSOCKETS")?.trim().toLowerCase() === "true";
  }

  deerFlowGatewayUrl() {
    return this.config.get<string>("DEERFLOW_GATEWAY_URL")?.trim();
  }

  deerFlowGatewayMode() {
    const value = this.config.get<string>("DEERFLOW_GATEWAY_MODE")?.trim().toLowerCase();
    return value === "langgraph" ? "langgraph" : "vibe";
  }

  deerFlowGatewayPath() {
    return this.config.get<string>("DEERFLOW_GATEWAY_PATH")?.trim() || "/api/vibe/tasks";
  }

  deerFlowAssistantId() {
    return this.config.get<string>("DEERFLOW_ASSISTANT_ID")?.trim() || "agent";
  }

  deerFlowRequestTimeoutMs() {
    const value = Number(this.config.get<string>("DEERFLOW_REQUEST_TIMEOUT_MS"));
    return Number.isFinite(value) && value > 0 ? value : 180_000;
  }
}

function normalizeProvider(value: string | undefined, fallback: RuntimeProvider): RuntimeProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "codex" || normalized === "deerflow") return normalized;
  return fallback;
}

function safeProviderId(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_") || "vibe_openai_compatible";
}

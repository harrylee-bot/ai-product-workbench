import { AgentName, ModelTaskType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { decideAgentFallback } from "../src/ai/agent-fallback-policy";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";

describe("agent fallback policy", () => {
  it("classifies planning/design fallbacks as degraded previews", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.product_planner_agent,
      taskType: ModelTaskType.product_planning,
      fallbackMode: "config_only",
      error: new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "no model configured"),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.metadata).toEqual(
      expect.objectContaining({
        used: true,
        level: "degraded_preview",
        action: "review_required",
        allowsConfirmation: false,
        allowsKnowledgeExtraction: false,
        allowsExport: false,
      }),
    );
  });

  it("classifies deterministic rendering fallbacks as acceptable results", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.prd_writer_agent,
      taskType: ModelTaskType.prd_generation,
      fallbackMode: "config_only",
      error: new ModelGatewayError("MODEL_CONFIG_NOT_FOUND", "no model config"),
    });

    expect(decision.metadata).toEqual(
      expect.objectContaining({
        level: "acceptable_result",
        action: "continue",
        allowsConfirmation: true,
        allowsKnowledgeExtraction: true,
        allowsExport: true,
      }),
    );
  });

  it("requires user notification when runtime model calls fail in always mode", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.prototype_code_agent,
      taskType: ModelTaskType.prototype_code_generation,
      fallbackMode: "always",
      error: new ModelGatewayError("MODEL_API_KEY_INVALID", "bad key"),
    });

    expect(decision.metadata).toEqual(
      expect.objectContaining({
        level: "model_unavailable",
        action: "notify_user",
        allowsConfirmation: false,
        errorCode: "MODEL_API_KEY_INVALID",
      }),
    );
  });

  it("does not allow runtime call failures in config_only mode", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.prototype_code_agent,
      taskType: ModelTaskType.prototype_code_generation,
      fallbackMode: "config_only",
      error: new ModelGatewayError("MODEL_CALL_FAILED", "upstream failed"),
    });

    expect(decision.allowed).toBe(false);
  });
});

import { AgentName, ModelTaskType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { decideAgentFallback } from "../src/ai/agent-fallback-policy";
import { ModelGatewayError } from "../src/model-gateway/model-gateway.error";

describe("agent fallback policy", () => {
  it("never allows fallback for missing model configuration", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.product_planner_agent,
      taskType: ModelTaskType.product_planning,
      fallbackMode: "config_only",
      error: new ModelGatewayError("MODEL_PROVIDER_NOT_FOUND", "no model configured"),
    });

    expect(decision).toEqual({ allowed: false });
  });

  it("never allows fallback for runtime model failures even in always mode", () => {
    const decision = decideAgentFallback({
      agentName: AgentName.prototype_code_agent,
      taskType: ModelTaskType.prototype_code_generation,
      fallbackMode: "always",
      error: new ModelGatewayError("MODEL_API_KEY_INVALID", "bad key"),
    });

    expect(decision).toEqual({ allowed: false });
  });
});

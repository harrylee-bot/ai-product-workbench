import { describe, expect, it, vi } from "vitest";
import { DeerFlowRuntimeAdapter } from "../src/ai/runtime/deerflow-runtime.adapter";
import type { RequirementRuntimeInput, RequirementRuntimeOutput } from "../src/ai/runtime/external-runtime.types";

describe("DeerFlowRuntimeAdapter", () => {
  it("posts requirement intake tasks to the configured Vibe gateway and normalizes output", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        output: {
          productDesignDraft: {
            title: "签到活动",
            summary: "用户每天签到领取积分。",
            businessGoal: "提升日活和连续访问。",
            targetUsers: [{ name: "普通用户" }],
            pages: [{ name: "签到首页" }],
          },
          requirementDocumentDraft: {
            title: "签到活动 PRD",
            sections: [
              {
                id: "overview",
                title: "需求概述",
                type: "overview",
                content: "用户每天签到领取积分。",
                sourcePaths: ["summary"],
              },
            ],
          },
          message: "已生成产品状态和 PRD。",
        },
      }),
    } as Response);
    const adapter = new DeerFlowRuntimeAdapter({
      deerFlowGatewayUrl: () => "http://localhost:2026",
      deerFlowGatewayMode: () => "vibe",
      deerFlowGatewayPath: () => "/api/vibe/tasks",
      deerFlowRequestTimeoutMs: () => 1000,
    } as never);

    const result = await adapter.runTask<RequirementRuntimeInput, RequirementRuntimeOutput>({
      id: "runtime-task-1",
      provider: "deerflow",
      taskType: "intake_requirement",
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      input: {
        userInput: "做一个签到活动",
        conversationId: "conversation-1",
        recentMessages: [],
        attachments: [],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:2026/api/vibe/tasks",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(result.output?.productDesignDraft.title).toBe("签到活动");
    expect(result.output?.requirementDocumentDraft?.sections[0]?.type).toBe("overview");
    expect(result.events.map((item) => item.type)).toContain("runtime_task_completed");

    fetchMock.mockRestore();
  });

  it("passes generic runtime tasks through to the DeerFlow gateway contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({
        output: {
          patchType: "document",
          targetNodes: ["overview"],
          impactScope: ["businessRules"],
          operations: [{ op: "replace", path: "businessRules.0.description", value: "立即签到", reason: "用户修改文案" }],
          needUserConfirm: true,
          reason: "DeerFlow 规划 PatchPlan",
        },
      }),
    } as Response);
    const adapter = new DeerFlowRuntimeAdapter({
      deerFlowGatewayUrl: () => "http://localhost:2026",
      deerFlowGatewayMode: () => "vibe",
      deerFlowGatewayPath: () => "/api/vibe/tasks",
      deerFlowRequestTimeoutMs: () => 1000,
    } as never);

    const result = await adapter.runTask({
      id: "runtime-task-2",
      provider: "deerflow",
      taskType: "patch_prd",
      runId: "run-1",
      projectId: "project-1",
      userId: "user-1",
      input: {
        userInput: "把按钮改成立即签到",
        selectedRegion: { type: "document", targetId: "prd-1" },
        productDesignState: { id: "state-1", projectId: "project-1" },
      },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.contract).toBe("vibe.runtime.task.v1");
    expect(body.outputSchema).toBe("PatchPlan");
    expect(result.output).toEqual(expect.objectContaining({ patchType: "document" }));
    expect(result.events.map((item) => item.type)).toContain("runtime_task_completed");

    fetchMock.mockRestore();
  });
});

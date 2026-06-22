import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentFactory } from "../src/ai/self-generation/agent.factory";
import { MutationEngine, type SystemMutation } from "../src/ai/self-generation/mutation.engine";
import { SelfGenerationEngine } from "../src/ai/self-generation/self-generation.engine";
import type { SystemGraphService, SystemGraphSnapshot } from "../src/ai/self-generation/system.graph.service";
import type { SystemPreviewService } from "../src/ai/self-generation/system.preview.service";
import type { PrismaService } from "../src/prisma/prisma.service";

describe("Phase4 self-generation system", () => {
  it("previews a new dynamic agent and pipeline edge without mutating storage directly", () => {
    const factory = new AgentFactory();
    const engine = new MutationEngine({} as PrismaService, {} as SystemGraphService);
    const agent = factory.createFlowOptimizationAgent("Observed repeated flow bottlenecks.");
    const baseGraph: SystemGraphSnapshot = {
      version: 1,
      nodes: [
        node("orchestrator", "orchestrator"),
        node("evolution_engine", "tool"),
      ],
      edges: [{ from: "orchestrator", to: "evolution_engine", relation: "calls" }],
    };
    const mutations: SystemMutation[] = [
      {
        id: "mutation_add_flow_agent",
        type: "add_agent",
        target: agent.id,
        payload: factory.toNode(agent),
        reason: "Add a graph-level diagnostic agent.",
        riskLevel: "medium",
      },
      {
        id: "mutation_add_flow_edge",
        type: "add_step",
        target: "pipeline",
        payload: { from: "evolution_engine", to: agent.id, relation: "feeds" },
        reason: "Feed evolution signals into the diagnostic agent.",
        riskLevel: "medium",
      },
    ];

    const preview = engine.previewApply(baseGraph, mutations);

    expect(baseGraph.nodes).toHaveLength(2);
    expect(preview.nodes.some((item) => item.id === agent.id && item.status === "experimental")).toBe(true);
    expect(preview.edges).toContainEqual({ from: "evolution_engine", to: agent.id, relation: "feeds" });
  });

  it("supports modify_pipeline payloads and rejects protected system targets", () => {
    const engine = new MutationEngine({} as PrismaService, {} as SystemGraphService);
    const graph: SystemGraphSnapshot = {
      version: 1,
      nodes: [node("decision_engine", "tool"), node("review_board", "tool"), node("risk_checker", "tool")],
      edges: [{ from: "decision_engine", to: "review_board", relation: "calls" }],
    };

    const preview = engine.previewApply(graph, [
      {
        id: "mutation_insert_checker",
        type: "modify_pipeline",
        target: "pipeline",
        payload: {
          removeEdges: [{ from: "decision_engine", to: "review_board", relation: "calls" }],
          addEdges: [
            { from: "decision_engine", to: "risk_checker", relation: "calls" },
            { from: "risk_checker", to: "review_board", relation: "calls" },
          ],
        },
        reason: "Insert risk checker before review.",
        riskLevel: "medium",
      },
    ]);

    expect(preview.edges).not.toContainEqual({ from: "decision_engine", to: "review_board", relation: "calls" });
    expect(preview.edges).toContainEqual({ from: "decision_engine", to: "risk_checker", relation: "calls" });
    expect(() =>
      engine.previewApply(graph, [
        {
          id: "mutation_security",
          type: "modify_agent",
          target: "security",
          payload: { status: "inactive" },
          reason: "Invalid protected mutation.",
          riskLevel: "high",
        },
      ]),
    ).toThrow(ForbiddenException);
  });

  it("creates a preview before auto-applying low-risk self-generation changes", async () => {
    const previews = {
      createPreview: vi.fn().mockResolvedValue({
        id: "proposal_1",
        status: "preview",
        riskLevel: "low",
        mutations: [],
        impactAnalysis: [],
        previewGraph: { version: 2, nodes: [], edges: [] },
        createdAt: "2026-06-22T00:00:00.000Z",
      }),
    } as unknown as SystemPreviewService;
    const mutations = {
      applyProposal: vi.fn().mockResolvedValue({
        status: "applied",
        proposalId: "proposal_1",
        graph: { version: 3, nodes: [], edges: [] },
      }),
    } as unknown as MutationEngine;
    const engine = new SelfGenerationEngine(new AgentFactory(), previews, mutations);

    const result = await engine.run({
      projectId: "project_1",
      createdBy: "user_1",
      traceId: "trace_1",
      finalOutcome: "success",
      riskLevel: "low",
    });

    expect(previews.createPreview).toHaveBeenCalledOnce();
    expect(mutations.applyProposal).toHaveBeenCalledWith({
      projectId: "project_1",
      proposalId: "proposal_1",
      confirm: true,
      createdBy: "user_1",
    });
    expect(result.applied?.status).toBe("applied");
  });
});

function node(id: string, type: "agent" | "orchestrator" | "tool" | "policy" | "compiler") {
  return {
    id,
    type,
    name: id,
    status: "active" as const,
    config: {},
  };
}

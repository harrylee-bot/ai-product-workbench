import type { PrdDocument } from "@workbench/workbench-contracts";

export function prdDocument(): PrdDocument {
  const text = (value: string) => [{ type: "text" as const, text: value, marks: [] }];
  return {
    protocol: "workbench.prd.v1",
    documentId: "prd-doc",
    title: "Production PRD",
    revision: {
      number: 1,
      status: "draft",
      summary: "Initial",
      changedAt: "2026-07-14T00:00:00.000Z",
      changedById: null,
    },
    assumptions: [],
    citations: [{
      id: "citation-1",
      documentId: "source-doc",
      chunkId: "source-chunk",
      sourcePath: "knowledge-vault/source.md",
      title: "Source",
      quote: "Evidence",
      locator: { heading: "Context", startLine: 1, endLine: 2 },
    }],
    sections: {
      executiveSummary: {
        title: "Executive summary",
        blocks: [{
          id: "summary",
          type: "paragraph",
          content: [
            { type: "text", text: "Initial summary", marks: ["strong"] },
            { type: "link", text: " source", href: "https://example.com/source" },
            { type: "citation", citationId: "citation-1", label: "Evidence" },
            { type: "reference", targetType: "goal", targetId: "goal-1", label: "Goal" },
          ],
        }],
      },
      problem: {
        title: "Problem",
        blocks: [{ id: "problem", type: "paragraph", content: text("Problem") }],
      },
      goals: {
        title: "Goals",
        blocks: [{
          id: "goal-1",
          type: "goal",
          title: "Goal",
          description: text("Goal description"),
          successMetric: "Metric",
          priority: "primary",
        }],
      },
      targetUsers: {
        title: "Users",
        blocks: [{
          id: "persona-1",
          type: "persona",
          name: "User",
          description: text("Persona description"),
          needs: ["Need"],
          painPoints: ["Pain"],
        }],
      },
      scope: {
        title: "Scope",
        blocks: [{
          id: "scope-list",
          type: "bulletList",
          items: [{ id: "scope-item", content: text("Scope") }],
        }],
      },
      requirements: {
        title: "Requirements",
        blocks: [{
          id: "requirement-1",
          type: "requirement",
          title: "Requirement",
          description: text("Requirement description"),
          priority: "must",
          goalIds: ["goal-1"],
          acceptanceCriterionIds: ["criterion-1"],
        }],
      },
      userFlows: {
        title: "Flows",
        blocks: [{
          id: "flow-1",
          type: "flow",
          title: "Flow",
          actor: "User",
          trigger: "Open",
          steps: [{ id: "step-1", text: "Step", requirementIds: ["requirement-1"] }],
          outcome: "Done",
        }],
      },
      acceptanceCriteria: {
        title: "Acceptance",
        blocks: [{
          id: "criterion-1",
          type: "acceptanceCriterion",
          requirementIds: ["requirement-1"],
          given: text("Given"),
          when: text("When"),
          then: text("Then"),
        }],
      },
      risksAndDependencies: {
        title: "Risks",
        blocks: [{
          id: "risk-1",
          type: "risk",
          description: text("Risk"),
          likelihood: "low",
          impact: "low",
          mitigation: text("Mitigate"),
        }],
      },
    },
  };
}

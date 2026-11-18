import { expect, it } from "vitest";
import { requirementSessionSchema } from "@workbench/workbench-contracts";
import { requirementView } from "./requirement-view-adapter";
import { requirementConfirmationBlock } from "./requirements-view";
const session = (extra = {}) =>
  requirementSessionSchema.parse({
    id: "session-one",
    projectId: "project-one",
    threadId: "thread-one",
    revision: 1,
    state: "discussing",
    context: { kind: "new" },
    generationRequest: {
      prompt: "了解现有能力",
      modelId: "chosen-model",
      workflow: "generate",
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      sourceIds: [],
      requestedArtifactKinds: ["prd"],
    },
    summaryVersion: 0,
    summaryChecksum: null,
    card: null,
    evidence: [],
    activeTurn: null,
    confirmation: null,
    createdAt: "2026-11-17T00:00:00Z",
    updatedAt: "2026-11-17T00:00:00Z",
    ...extra,
  });
const options = {
  scopeKey: "actor/project/thread",
  contextLabel: "新需求",
  entries: [],
  pendingConfirmation: false,
  hasMore: false,
};
it("does not manufacture a complete card or infer missing knowledge from an early conversation", () => {
  const view = requirementView(session(), options);
  expect(view.review).toBeUndefined();
  expect(view.canConfirm).toBe(false);
  expect(view.knowledgeStatus).toBe("not-provided");
});

it.each([
  ["REQUIREMENT_SOURCE_UNAVAILABLE", "restricted"],
  ["REQUIREMENT_SOURCE_CHANGED", "source-changed"],
  ["REQUIREMENT_KNOWLEDGE_UNAVAILABLE", "unavailable"],
])("displays the server's %s without exposing source details", (failureCode, knowledgeStatus) => {
  const now = "2026-11-17T00:00:00Z";
  const activeTurn = { id: "turn-one", sessionId: "session-one", inputRevision: 1, status: "failed",
    modelId: "deepseek-flash", attempt: 1, failureCode, inputTokens: null, outputTokens: null, createdAt: now, finishedAt: now };
  expect(requirementView(session({ activeTurn }), options)).toMatchObject({ knowledgeStatus, canConfirm: false, evidence: [] });
});

it("distinguishes explicitly unaffected dimensions from missing fields", () => {
  const known = requirementView(
    session({ card: { affectedPages: [], affectedFlows: [] } }),
    options,
  );
  const unknown = requirementView(
    session({ card: { goal: "后台规则调整" } }),
    options,
  );
  expect(known.review?.pagesUnaffected).toBe(true);
  expect(known.review?.flowsUnaffected).toBe(true);
  expect(unknown.review?.pagesUnaffected).toBe(false);
  expect(unknown.review?.flowsUnaffected).toBe(false);
});
it("keeps a partial card unconfirmable even if a server incorrectly marks it ready", () => {
  const view = requirementView(
    session({
      state: "ready_to_confirm",
      summaryVersion: 1,
      summaryChecksum: "a".repeat(64),
      card: {
        goal: "了解能力",
        platform: null,
        changes: [],
        roles: [],
        modules: [],
      },
    }),
    options,
  );
  expect(view.canConfirm).toBe(false);
  expect(view.review?.platform).toBeUndefined();
  expect(view.review?.changes).toEqual([]);
});
it("does not label model-authored change summaries as statements already made by the user", () => {
  const view = requirementView(
    session({
      card: {
        reuse: ["沿用登录"],
        changes: ["增加限制"],
        assumptions: [{ id: "a", text: "字段放在规则区", evidenceIds: [] }],
      },
    }),
    options,
  );
  expect(view.review?.changes[0]?.origin).toBe("analysis");
  expect(view.review?.reuse[0]?.origin).toBe("analysis");
  expect(view.review?.assumptions[0]?.origin).toBe("suggestion");
});
it("keeps critical financial and permission questions blocking when an individual flag is false", () => {
  const view = requirementView(
    session({
      card: {
        issues: [
          {
            id: "q",
            kind: "missing",
            question: "退款权限由谁拥有？",
            impact: "financial",
            blocking: false,
            evidenceIds: [],
          },
        ],
      },
    }),
    options,
  );
  expect(view.questions[0]?.blocking).toBe(true);
  expect(
    requirementConfirmationBlock(
      {
        ...view,
        reviewCurrent: true,
        review: { id: "s", version: 1 } as never,
      },
      { canEdit: true, dirtyInput: false },
    ),
  ).toContain("关键规则");
});
it("distinguishes explicit knowledge conflicts from absent citations", () => {
  const view = requirementView(
    session({
      card: {
        issues: [
          {
            id: "q",
            kind: "conflict",
            question: "哪个区域适用？",
            impact: "scope",
            blocking: true,
            evidenceIds: [],
          },
        ],
      },
    }),
    options,
  );
  expect(view.knowledgeStatus).toBe("conflict");
});

it("keeps the original generation visible alongside the next discussion card", () => {
  const view = requirementView(session({ card: { goal: "下一版补充" } }), {
    ...options,
    generationBaseline: {
      id: "confirmation-one",
      summaryVersion: 2,
      summaryChecksum: "a".repeat(64),
      status: "started",
      failureCode: null,
      acceptedAssumptionIds: [],
      acceptedPlatformChanges: false,
      confirmedAt: "2026-11-17T00:00:00Z",
      planId: "plan-one",
      runId: "run-one",
    },
  });
  expect(view.currentGeneration?.baseline).toContain("需求第 2 版");
  expect(view.review?.goal).toBe("下一版补充");
});

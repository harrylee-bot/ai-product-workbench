import {
  requirementCardSchema,
  type RequirementSession,
  type ThreadEntry,
} from "@workbench/workbench-contracts";
import type {
  RequirementDiscussionView,
  RequirementFactView,
} from "./requirements-view";

/** Map the fixed backend contract to display props. Incomplete cards stay
 * incomplete; model-authored changes are never relabelled as user facts. */
export function requirementView(
  session: RequirementSession | undefined,
  options: {
    scopeKey: string;
    contextLabel: string;
    entries: readonly ThreadEntry[];
    pendingConfirmation: boolean;
    hasMore: boolean;
    generationBaseline?: NonNullable<RequirementSession["confirmation"]>;
  },
): RequirementDiscussionView {
  const card = session?.card;
  const baseline =
    session?.confirmation?.status === "started"
      ? session.confirmation
      : options.generationBaseline;
  const full = requirementCardSchema.safeParse(card);
  const issues = card?.issues ?? [];
  const active =
    session?.activeTurn &&
    ["queued", "running"].includes(session.activeTurn.status);
  const toFacts = (
    strings: readonly string[] = [],
    prefix: string,
  ): RequirementFactView[] =>
    strings.map((text, index) => ({
      id: `${prefix}:${index}`,
      text,
      origin: "analysis",
      evidenceIds: [],
    }));
  const view: RequirementDiscussionView = {
    scopeKey: options.scopeKey,
    contextLabel: options.contextLabel,
    status:
      session?.state === "analyzing"
        ? "analyzing"
        : session?.state === "ready_to_confirm"
          ? "ready"
          : session?.state === "generating" || session?.state === "confirmed"
            ? "generating"
            : session?.state === "needs_clarification"
              ? "needs-clarification"
              : "discussing",
    messages: options.entries.flatMap((entry) =>
      entry.content.type === "user.prompt" ||
      entry.content.type === "assistant.message"
        ? [
            {
              id: entry.id,
              speaker:
                entry.content.type === "user.prompt"
                  ? ("user" as const)
                  : ("assistant" as const),
              text: entry.content.text,
              afterConfirmation:
                !!baseline && entry.createdAt > baseline.confirmedAt,
            },
          ]
        : [],
    ),
    questions: issues.map((issue) => ({
      id: issue.id,
      question: issue.question,
      reason: {
        scope: "影响本次交付范围",
        workflow: "影响业务流程",
        permission: "影响角色及数据权限",
        financial: "涉及权益或资损",
        external_dependency: "涉及外部依赖",
        platform: "涉及平台级改造",
        presentation: "影响展示细节",
      }[issue.impact],
      blocking: issue.blocking || issue.impact !== "presentation",
      evidenceIds: issue.evidenceIds,
    })),
    evidence: (session?.evidence ?? []).map((source) => ({
      id: source.id,
      title: source.title,
      location: source.sourcePath,
      quote: source.quote,
      release: source.releaseId,
      version: source.releaseVersion,
      scope: source.scope,
    })),
    knowledgeStatus: active
      ? "searching"
      : issues.some((issue) => issue.kind === "conflict")
        ? "conflict"
        : issues.some((issue) => issue.kind === "knowledge_missing")
          ? "missing"
          : session?.evidence.length
            ? "available"
            : "not-provided",
    canConfirm:
      !!session &&
      session.state === "ready_to_confirm" &&
      full.success &&
      !!session.summaryChecksum &&
      !active,
    reviewCurrent: !!session && !active,
    confirmationPending: options.pendingConfirmation,
    generationStarting: session?.confirmation?.status === "pending",
    hasEarlierMessages: options.hasMore,
  };
  if (card && session)
    view.review = {
      id: session.id,
      version: session.summaryVersion,
      goal: card.goal ?? "需求仍在梳理中",
      platform: card.platform ?? undefined,
      roles: card.roles ?? [],
      rolesUnchanged: full.success && card.roles?.length === 0,
      modules: card.modules ?? [],
      existing: (card.existingCapabilities ?? []).map((capability, index) => ({
        id: `existing:${index}`,
        text: capability.description,
        origin: "knowledge",
        evidenceIds: capability.evidenceIds,
      })),
      reuse: toFacts(card.reuse, "reuse"),
      changes: toFacts(card.changes, "change"),
      assumptions: (card.assumptions ?? []).map((assumption) => ({
        ...assumption,
        origin: "suggestion" as const,
      })),
      pages: card.affectedPages ?? [],
      flows: card.affectedFlows ?? [],
      pagesUnaffected: card.affectedPages?.length === 0,
      flowsUnaffected: card.affectedFlows?.length === 0,
      preserved: card.preserved ?? [],
      platformChanges: card.platformChanges ?? [],
      target:
        card.targetSurface === "app"
          ? "App"
          : card.targetSurface === "web"
            ? "Web"
            : "终端待明确",
      design: card.designConstraints ?? [],
      outputKinds: card.outputKinds ?? [],
    };
  if (baseline?.status === "started")
    view.currentGeneration = {
      label: "已确认的生成",
      baseline: `需求第 ${baseline.summaryVersion} 版 · ${baseline.summaryChecksum.slice(0, 12)}`,
    };
  return view;
}

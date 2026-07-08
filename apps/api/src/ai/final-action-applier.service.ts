import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConversationDesignStateStatus } from "@prisma/client";
import crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import { PrototypeService, sanitizePrototypeHtml } from "./prototype.service";
import { RequirementDocumentService } from "./requirement-document.service";
import type {
  AssumptionReference,
  ConversationDesignDraft,
  ConversationDesignState,
  PrototypeArtifact,
  PrototypeArtifactDraft,
  PrototypeSpec,
  PrototypeTargetDevice,
  RequirementDocSection,
  RequirementDocument,
  RequirementDocumentDraft,
} from "./ai-vibe.types";
import type {
  DeerFlowFinalAction,
  DeerFlowKnowledgeReference,
  DeerFlowResolvedArtifact,
} from "./deerflow-runtime.service";
import { formatRequirementDocumentDraft } from "./requirement-document-format";

type CurrentRequirementDocumentRecord = {
  id: string;
  title: string;
  sections: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  pendingQuestions: unknown;
  validationNotes: unknown;
};

/**
 * DeerFlow 落库桥接（审计 P0 根因修复）。
 *
 * runDeerFlowTurn 拿到 DeerFlow 的 finalAction 后，本服务按 type 把产物落库：
 * - review_prd → 保存 RequirementDocument + 写入 ConversationDesignState.prdDocument
 * - review_prototype → 保存 PrototypeArtifact + PrototypeSpec + 写入 ConversationDesignState.prototypeSpec
 *
 * 修复审计 pipe-1 / pipe-2 / pipe-3 / pipe-4 / pipe-5 / backend-core-1 / knowledge-core-1：
 * 此前 saveGeneratedDocument / saveGeneratedPrototype 全仓零调用，PRD/原型永不进库；
 * 现已由本服务在 final-action 应用阶段调用，PRD/原型正常落库。
 */
@Injectable()
export class FinalActionApplierService {
  private readonly logger = new Logger(FinalActionApplierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ConversationDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
  ) {}

  async apply(input: {
    conversationId: string;
    userId: string;
    runId: string;
    finalAction: DeerFlowFinalAction;
    artifacts: DeerFlowResolvedArtifact[];
    assistantText?: string;
    knowledgeContext?: DeerFlowKnowledgeReference[];
  }): Promise<{
    prdDocument?: RequirementDocument;
    prototypeArtifact?: PrototypeArtifact;
    state?: unknown;
  }> {
    const raw = asRecord(input.finalAction.raw);

    if (input.finalAction.type === "review_prd") {
      return this.applyReviewPrd(input, raw);
    }
    if (input.finalAction.type === "review_prototype") {
      if (hasPrdPayload(raw, input.artifacts, input.assistantText)) {
        return this.applyReviewPrd(input, raw);
      }
      return this.applyReviewPrototype(input, raw);
    }
    return {};
  }

  private async applyReviewPrd(
    input: {
      conversationId: string;
      userId: string;
      runId: string;
      finalAction: DeerFlowFinalAction;
      artifacts: DeerFlowResolvedArtifact[];
      assistantText?: string;
      knowledgeContext?: DeerFlowKnowledgeReference[];
    },
    raw: Record<string, unknown> | undefined,
  ) {
    // G1-1：将 createDraft → saveGeneratedDocument → attachGeneratedArtifacts 三步合并到一个事务中，
    // 避免中途失败留下不一致状态（state 已创建但 document 未保存，或 document 已保存但 state 未关联）。
    return this.prisma.$transaction(async (tx) => {
      const previousDocument = await this.getCurrentRequirementDocument(input.conversationId, tx);
      const stateDraft = this.buildConversationDesignDraft(
        input.conversationId,
        raw,
        input.userId,
        input.knowledgeContext,
      );
      const state = await this.stateService.createDraftInTransaction(tx, input.conversationId, stateDraft, {
        userId: input.userId,
        runId: input.runId,
        reason: "DeerFlow review_prd：生成 PRD 前更新产品设计状态",
      });

      const documentDraft = this.buildRequirementDocumentDraft(
        input.conversationId,
        raw,
        input.artifacts,
        input.assistantText || input.finalAction.message,
        previousDocument,
        state,
        input.userId,
        input.knowledgeContext,
      );
      const document = await this.documentService.saveGeneratedDocumentInTransaction(tx, state, documentDraft, {
        userId: input.userId,
        runId: input.runId,
        reason: "DeerFlow 生成 PRD",
      });

      const updatedState = await this.stateService.attachGeneratedArtifactsInTransaction(tx, state.id, {
        prdDocument: document,
        status: ConversationDesignStateStatus.doc_ready,
        userId: input.userId,
        runId: input.runId,
        reason: "DeerFlow 生成 PRD，写入 ConversationDesignState",
      });

      if (hasPrototypePayload(raw, input.artifacts)) {
        const prototypeResult = await this.savePrototypeForStateInTransaction(
          tx,
          updatedState,
          input,
          raw,
        );
        const stateWithPrototype = await this.stateService.attachGeneratedArtifactsInTransaction(tx, updatedState.id, {
          prdDocument: document,
          prototypeSpec: prototypeResult.prototypeSpec,
          status: ConversationDesignStateStatus.prototype_ready,
          userId: input.userId,
          runId: input.runId,
          reason: "DeerFlow 同轮生成 PRD 和原型，写入 ConversationDesignState",
        });
        return {
          prdDocument: document,
          prototypeArtifact: prototypeResult.artifact,
          state: stateWithPrototype,
        };
      }

      return { prdDocument: document, state: updatedState };
    });
  }

  private async applyReviewPrototype(
    input: {
      conversationId: string;
      userId: string;
      runId: string;
      finalAction: DeerFlowFinalAction;
      artifacts: DeerFlowResolvedArtifact[];
      knowledgeContext?: DeerFlowKnowledgeReference[];
    },
    raw: Record<string, unknown> | undefined,
  ) {
    // G1-1：将 saveGeneratedPrototype → attachGeneratedArtifacts 两步合并到一个事务中。
    return this.prisma.$transaction(async (tx) => {
      const state = await this.stateService.getCurrentStateInTransaction(tx, input.conversationId);
      if (!state) {
        throw new Error("PROTOTYPE_STATE_NOT_FOUND：生成原型前需要先有 ConversationDesignState（通常先 review_prd）。");
      }

      const result = await this.savePrototypeForStateInTransaction(tx, state, input, raw);

      const updatedState = await this.stateService.attachGeneratedArtifactsInTransaction(tx, state.id, {
        prototypeSpec: result.prototypeSpec,
        status: ConversationDesignStateStatus.prototype_ready,
        userId: input.userId,
        runId: input.runId,
        reason: "DeerFlow 生成原型，写入 ConversationDesignState",
      });

      return { prototypeArtifact: result.artifact, state: updatedState };
    });
  }

  private async savePrototypeForStateInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    state: ConversationDesignState,
    input: {
      conversationId: string;
      userId: string;
      runId: string;
      finalAction: DeerFlowFinalAction;
      artifacts: DeerFlowResolvedArtifact[];
      knowledgeContext?: DeerFlowKnowledgeReference[];
    },
    raw: Record<string, unknown> | undefined,
  ) {
    const prototypeSpec = this.buildPrototypeSpec(
      state.conversationId,
      state.id,
      state.version,
      raw,
      input.knowledgeContext,
    );
    const artifactDraft = this.buildPrototypeArtifactDraft(input.conversationId, raw, input.artifacts, input.finalAction.message);

    // 预先净化 HTML，以便在事务中使用
    const rawHtml = artifactDraft.htmlContent ?? artifactDraft.html ?? "";
    const htmlContent = sanitizePrototypeHtml(rawHtml);
    const hasContent = htmlContent.trim().length > 0;

    const result = await this.prototypeService.saveGeneratedPrototypeInTransaction(tx, state, prototypeSpec, artifactDraft, {
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow 生成原型",
    }, htmlContent, hasContent);
    if (!result.hasContent) {
      throw new BadRequestException("PROTOTYPE_HTML_EMPTY_AFTER_SANITIZE");
    }
    return result;
  }

  private buildConversationDesignDraft(
    conversationId: string,
    raw: Record<string, unknown> | undefined,
    userId: string,
    knowledgeContext?: DeerFlowKnowledgeReference[],
  ): ConversationDesignDraft {
    const stateDraft = asRecord(raw?.designStateDraft);
    const assumptions = toAssumptionReferences(raw?.assumptions);
    const knowledgeRefs = buildKnowledgeRefRecords(raw?.knowledgeRefsUsed, knowledgeContext);
    return {
      conversationId,
      title: toRequirementTitleCandidate(stateDraft?.title) || "产品需求方案",
      summary: toStringValue(stateDraft?.summary),
      background: toStringValue(stateDraft?.background),
      businessGoal: toStringValue(stateDraft?.businessGoal) || toStringValue(stateDraft?.summary) || "待补充业务目标",
      targetUsers: toArray(stateDraft?.targetUsers),
      userScenarios: toArray(stateDraft?.userScenarios),
      pages: toArray(stateDraft?.pages),
      features: toArray(stateDraft?.features),
      backendConfigs: toArray(stateDraft?.backendConfigs),
      frontendRules: toArray(stateDraft?.frontendRules),
      businessRules: toArray(stateDraft?.businessRules),
      stateRules: toArray(stateDraft?.stateRules),
      exceptionScenarios: toArray(stateDraft?.exceptionScenarios),
      acceptanceCriteria: toArray(stateDraft?.acceptanceCriteria),
      prototypeOutline: toRecord(stateDraft?.prototypeOutline),
      assumptions,
      knowledgeRefs,
      pendingQuestions: [],
      confirmedFacts: [],
      createdBy: userId,
    } as ConversationDesignDraft;
  }

  private buildRequirementDocumentDraft(
    conversationId: string,
    raw: Record<string, unknown> | undefined,
    artifacts: DeerFlowResolvedArtifact[],
    fallbackMessage: string,
    previousDocument?: CurrentRequirementDocumentRecord,
    state?: ConversationDesignState,
    userId?: string,
    knowledgeContext?: DeerFlowKnowledgeReference[],
  ): RequirementDocumentDraft {
    const prdDraft = asRecord(raw?.prdDocumentDraft);
    const rawTitle = toRequirementTitleCandidate(prdDraft?.title);
    const fallbackTitle =
      toRequirementTitleCandidate(state?.title) ||
      toRequirementTitleCandidate(asRecord(raw?.designStateDraft)?.title);
    const title =
      rawTitle ||
      fallbackTitle ||
      "需求文档";
    let sections = toSections(prdDraft?.sections);

    if (sections.length === 0) {
      // DeerFlow 通常把 PRD 正文以 markdown artifact 形式产出；尝试从中解析段落。
      const markdown = findPrdArtifactText(artifacts);
      const body = markdown ?? fallbackMessage;
      sections = looksLikePrdCompletionSummary(body)
        ? []
        : markdownToSections(body, title);
    }

    if (!isSubstantialPrdSections(sections) && previousDocument) {
      return formatRequirementDocumentDraft(mergeSummaryIntoPreviousDocument(
        conversationId,
        previousDocument,
        fallbackMessage || sectionsToPlainText(sections),
      ), state, { author: userId });
    }

    return formatRequirementDocumentDraft({
      conversationId,
      title,
      sections,
      knowledgeRefs: buildKnowledgeRefRecords(raw?.knowledgeRefsUsed, knowledgeContext),
      assumptions: toAssumptionReferences(raw?.assumptions),
      pendingQuestions: [],
      validationNotes: [
        ...toStringArray(raw?.validationNotes),
        ...toStringArray(prdDraft?.validationNotes),
        ...externalEnrichmentValidationNotes(raw),
      ],
    }, state, { author: userId });
  }

  private async getCurrentRequirementDocument(conversationId: string, tx?: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0]) {
    const prisma = tx ?? this.prisma;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { currentPrdDocumentId: true },
    });

    const select = {
      id: true,
      title: true,
      sections: true,
      assumptions: true,
      knowledgeRefs: true,
      pendingQuestions: true,
      validationNotes: true,
    } as const;

    const documents = await prisma.requirementDocument.findMany({
      where: { conversationId },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select,
    });
    const current = conversation?.currentPrdDocumentId
      ? documents.find((document) => document.id === conversation.currentPrdDocumentId)
      : undefined;
    const candidates = current
      ? [current, ...documents.filter((document) => document.id !== current.id)]
      : documents;

    return candidates.find((document) => isSubstantialPrdSections(toSections(document.sections)))
      ?? current
      ?? documents[0]
      ?? undefined;
  }

  private buildPrototypeSpec(
    conversationId: string,
    stateId: string,
    stateVersion: number,
    raw: Record<string, unknown> | undefined,
    knowledgeContext?: DeerFlowKnowledgeReference[],
  ): PrototypeSpec {
    const spec = asRecord(raw?.prototypeSpec);
    const id = crypto.randomUUID();
    return {
      id,
      conversationId,
      conversationDesignStateId: stateId,
      conversationDesignStateVersion: stateVersion,
      title: toStringValue(spec?.title) || "原型",
      targetDevice: toTargetDevice(spec?.targetDevice),
      styleGuide: (toRecord(spec?.styleGuide) ?? {}) as PrototypeSpec["styleGuide"],
      pages: toArray(spec?.pages) as PrototypeSpec["pages"],
      navigation: toArray(spec?.navigation) as PrototypeSpec["navigation"],
      interactions: toArray(spec?.interactions) as PrototypeSpec["interactions"],
      assumptions: toAssumptionReferences(raw?.assumptions),
      knowledgeRefs: buildKnowledgeRefRecords(raw?.knowledgeRefsUsed, knowledgeContext),
      generatedByRunId: undefined,
    };
  }

  private buildPrototypeArtifactDraft(
    conversationId: string,
    raw: Record<string, unknown> | undefined,
    artifacts: DeerFlowResolvedArtifact[],
    fallbackMessage: string,
  ): PrototypeArtifactDraft {
    const html = findArtifactText(artifacts, ["prototype_html", "html", "prototype"], ["text/html"]);
    return {
      conversationId,
      htmlContent: html ?? "",
      html: html ?? "",
      title: toStringValue(asRecord(raw?.prototypeSpec)?.title) || "原型",
      entryFilePath: "index.html",
      entryFile: "index.html",
      targetDevice: toTargetDevice(asRecord(raw?.prototypeSpec)?.targetDevice),
      pageCount: 1,
      errorMessage: html ? undefined : (fallbackMessage || "未取到原型 HTML 内容"),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function hasPrdPayload(
  raw: Record<string, unknown> | undefined,
  artifacts: DeerFlowResolvedArtifact[],
  assistantText?: string,
) {
  const prdDraft = asRecord(raw?.prdDocumentDraft);
  if (isSubstantialPrdSections(toSections(prdDraft?.sections))) return true;
  if (findPrdArtifactText(artifacts)) return true;
  if (assistantText && !looksLikePrdCompletionSummary(assistantText)) {
    return isSubstantialPrdSections(markdownToSections(assistantText, toStringValue(prdDraft?.title) || "需求文档"));
  }
  return false;
}

function hasPrototypePayload(
  raw: Record<string, unknown> | undefined,
  artifacts: DeerFlowResolvedArtifact[],
) {
  return Boolean(asRecord(raw?.prototypeSpec))
    && Boolean(findArtifactText(artifacts, ["prototype_html", "html", "prototype"], ["text/html"]));
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return cleanPersistedText(value) || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function toRequirementTitleCandidate(value: unknown): string | undefined {
  const title = toStringValue(value);
  if (!title) return undefined;
  if (!looksLikePrdCompletionSummary(title)) return title;
  return extractRequirementTitleFromCompletionSummary(title);
}

function extractRequirementTitleFromCompletionSummary(value: string) {
  const quoted = value.match(/《([^》]{2,120}(?:需求说明书|需求文档|产品需求文档|PRD)?)》/i)?.[1]?.trim();
  if (quoted) return quoted;

  return value.match(/(?:已生成|已完成|已写入)\s*([^，。；\n]{2,80}(?:需求说明书|需求文档|产品需求文档|PRD))/i)?.[1]?.trim();
}

function toArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? sanitizePersistedRecord(item as Record<string, unknown>)
      : { value: cleanPersistedText(String(item)) }
  ));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toStringValue(item) ?? toStringValue(asRecord(item)?.content) ?? toStringValue(asRecord(item)?.message))
    .filter((item): item is string => Boolean(item));
}

function externalEnrichmentValidationNotes(raw: Record<string, unknown> | undefined): string[] {
  if (!raw) return [];
  const notes: string[] = [];
  const status = toStringValue(raw.externalResearchStatus);
  if (status) notes.push(`外部补充状态：${status}`);
  for (const item of toStringArray(raw.enrichmentNotes).slice(0, 5)) {
    notes.push(`补齐说明：${item}`);
  }
  const refs = toStringArray(raw.externalRefsUsed).slice(0, 5);
  if (refs.length) notes.push(`外部参考：${refs.join("；")}`);
  return notes;
}

function toAssumptionReferences(value: unknown): AssumptionReference[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const text = typeof item === "string" ? item : toStringValue(asRecord(item)?.content) ?? toStringValue(asRecord(item)?.description) ?? "";
    return {
      assumptionId: `assumption_${index + 1}`,
      content: text,
      relatedSectionIds: [],
      status: "pending" as const,
    };
  });
}

function buildKnowledgeRefRecords(
  value: unknown,
  knowledgeContext?: DeerFlowKnowledgeReference[],
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const add = (record: Record<string, unknown>) => {
    const title = toStringValue(record.title);
    const relatedPath = toStringValue(record.relatedPath);
    const knowledgeId = toStringValue(record.knowledgeId);
    const key = normalizeKnowledgeRefKey(knowledgeId || relatedPath || title || JSON.stringify(record));
    if (!key || seen.has(key)) return;
    seen.add(key);
    records.push({
      id: toStringValue(record.id) || `knowledge_ref_${records.length + 1}`,
      title: title || `知识引用 ${records.length + 1}`,
      knowledgeId: knowledgeId || toStringValue(record.sourceId) || `knowledge_${records.length + 1}`,
      snippet: toStringValue(record.snippet),
      type: toStringValue(record.type),
      score: typeof record.score === "number" ? record.score : undefined,
      semanticScore: typeof record.semanticScore === "number" ? record.semanticScore : undefined,
      reason: toStringValue(record.reason),
      relatedPath,
      sourceType: "knowledge_base",
      sourceId: knowledgeId || toStringValue(record.sourceId),
      visualAssets: Array.isArray(record.visualAssets) ? record.visualAssets : undefined,
    });
  };

  for (const item of knowledgeContext ?? []) {
    add({
      id: item.id,
      knowledgeId: item.knowledgeId,
      title: item.relatedPath ? `${item.title}（${item.relatedPath}）` : item.title,
      snippet: item.snippet || summarizeKnowledgeContent(item.content),
      type: item.type,
      score: item.score,
      semanticScore: item.semanticScore,
      reason: item.reason,
      relatedPath: item.relatedPath,
      visualAssets: item.visualAssets,
    });
  }

  for (const item of toRawKnowledgeRefRecords(value)) {
    const matched = findKnowledgeContextMatch(item, knowledgeContext ?? []);
    if (matched) {
      add({
        id: matched.id,
        knowledgeId: matched.knowledgeId,
        title: matched.relatedPath ? `${matched.title}（${matched.relatedPath}）` : matched.title,
        snippet: matched.snippet || summarizeKnowledgeContent(matched.content),
        type: matched.type,
        score: matched.score,
        semanticScore: matched.semanticScore,
        reason: matched.reason,
        relatedPath: matched.relatedPath,
        visualAssets: matched.visualAssets,
      });
      continue;
    }
    add(item);
  }

  return records.map((record, index) => ({
    ...record,
    id: toStringValue(record.id) || `knowledge_ref_${index + 1}`,
    knowledgeId: toStringValue(record.knowledgeId) || `knowledge_${index + 1}`,
  }));
}

function toRawKnowledgeRefRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === "string") {
      return { id: `knowledge_ref_model_${index + 1}`, title: item, knowledgeId: `knowledge_model_${index + 1}` };
    }
    const record = asRecord(item) ?? {};
    const title = toStringValue(record.title) ?? toStringValue(record.path) ?? `知识引用 ${index + 1}`;
    return {
      ...record,
      id: toStringValue(record.id) || `knowledge_ref_model_${index + 1}`,
      title,
      knowledgeId: toStringValue(record.knowledgeId) || toStringValue(record.sourceId) || `knowledge_model_${index + 1}`,
      relatedPath: toStringValue(record.relatedPath) || toStringValue(record.path),
    };
  });
}

function findKnowledgeContextMatch(
  record: Record<string, unknown>,
  knowledgeContext: DeerFlowKnowledgeReference[],
) {
  const titleNeedle = normalizeKnowledgeRefKey(String(record.title ?? ""));
  const pathNeedle = normalizeKnowledgeRefKey(String(record.relatedPath ?? ""));
  const idNeedle = normalizeKnowledgeRefKey(String(record.knowledgeId ?? ""));
  const needle = normalizeKnowledgeRefKey([titleNeedle, pathNeedle, idNeedle].join(" "));
  if (!needle && !titleNeedle && !pathNeedle && !idNeedle) return undefined;
  return knowledgeContext.find((item) => {
    const itemId = normalizeKnowledgeRefKey(String(item.knowledgeId ?? item.id ?? ""));
    const itemTitle = normalizeKnowledgeRefKey(item.title);
    const itemPath = normalizeKnowledgeRefKey(item.relatedPath ?? "");
    const haystack = normalizeKnowledgeRefKey([itemId, itemTitle, itemPath].join(" "));
    return (
      Boolean(idNeedle && itemId && (itemId.includes(idNeedle) || idNeedle.includes(itemId))) ||
      Boolean(pathNeedle && itemPath && (itemPath.includes(pathNeedle) || pathNeedle.includes(itemPath))) ||
      Boolean(titleNeedle && itemTitle && (titleNeedle.includes(itemTitle) || itemTitle.includes(titleNeedle))) ||
      Boolean(needle && haystack && (haystack.includes(needle) || needle.includes(haystack)))
    );
  });
}

function normalizeKnowledgeRefKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[（）()[\]{}《》"'`~!@#$%^&*+=|\\:;，,。.?？/\s_-]+/g, "")
    .trim();
}

function summarizeKnowledgeContent(content: string | undefined) {
  const text = cleanPersistedText(String(content ?? ""))
    .replace(/^来源文件[:：].*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 240);
}

function toTargetDevice(value: unknown): PrototypeTargetDevice {
  const v = String(value ?? "").toLowerCase();
  if (v === "desktop") return "desktop";
  if (v === "mobile") return "mobile";
  return "both";
}

function toSections(value: unknown): RequirementDocSection[] {
  if (!Array.isArray(value)) return [];
  const sections: RequirementDocSection[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) return;
    const content = toStringValue(record.content) ?? "";
    sections.push({
      id: toStringValue(record.id) ?? `section_${index + 1}`,
      title: toStringValue(record.title) ?? `段落 ${index + 1}`,
      type: (toStringValue(record.type) as RequirementDocSection["type"]) ?? "overview",
      level: (Number(record.level) || 1) as RequirementDocSection["level"],
      order: Number(record.order) || index + 1,
      content,
      blocks: Array.isArray(record.blocks)
        ? (record.blocks.map((block) => sanitizePersistedRecord(asRecord(block) ?? { content: String(block) })) as RequirementDocSection["blocks"])
        : undefined,
      sourcePaths: Array.isArray(record.sourcePaths) ? (record.sourcePaths as string[]) : [],
    });
  });
  return sections;
}

function sanitizePersistedRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizePersistedValue(value)]));
}

function sanitizePersistedValue(value: unknown): unknown {
  if (typeof value === "string") return cleanPersistedText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizePersistedValue(item));
  if (value && typeof value === "object") return sanitizePersistedRecord(value as Record<string, unknown>);
  return value;
}

function cleanPersistedText(value: string): string {
  const lines = String(value ?? "")
    .replace(/\u0000/g, "")
    .split(/\r?\n/);
  let inFinalActionBlock = false;
  const kept: string[] = [];

  for (const line of lines) {
    const compact = line.replace(/\s+/g, " ").trim();
    if (compact.includes("```ai_product_workbench_final_action")) {
      inFinalActionBlock = true;
      continue;
    }
    if (inFinalActionBlock) {
      if (compact.includes("```")) inFinalActionBlock = false;
      continue;
    }
    if (looksLikePersistedRuntimeNoise(compact)) continue;
    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function looksLikePersistedRuntimeNoise(text: string): boolean {
  if (!text) return false;
  return [
    /Context from AI Product Workbench/i,
    /Updated todo list/i,
    /\b(tool-input|tool-output|messages-tuple)\b/i,
    /\b(read_file|write_todos|write_file)\b/i,
    /^调用\s*(read_file|write_todos|write_file|search|fetch|bash)/i,
    /^执行\s*(read_file|write_todos|write_file|search|fetch|bash)/i,
    /^读取\s*(read_file|write_todos|write_file|search|fetch|bash)/i,
  ].some((pattern) => pattern.test(text));
}

function isSubstantialPrdSections(sections: RequirementDocSection[]) {
  if (looksLikeAdviceDocument(sections)) return false;
  if (sections.length >= 4) return true;
  const text = sectionsToPlainText(sections);
  if (text.length >= 800) return true;
  return sections.some((section) =>
    /项目概述|产品目标|目标用户|用户场景|业务规则|后台配置|验收标准|异常|数据|埋点|状态流转/.test(
      `${section.title}\n${section.content}`,
    ),
  );
}

function looksLikeAdviceDocument(sections: RequirementDocSection[]) {
  if (!sections.length) return false;
  const text = sectionsToPlainText(sections).slice(0, 4000);
  const adviceHits = (text.match(/建议|可以补充|提升.*质量|评审更容易|研发更容易|运营更容易/g) ?? []).length;
  const prdBodyHits = (text.match(/项目概述|产品目标|需求范围|业务规则|功能需求|后台配置|验收标准|异常场景/g) ?? []).length;
  return adviceHits >= 4 && prdBodyHits < 4;
}

function looksLikePrdCompletionSummary(value: string | undefined) {
  const text = value?.trim();
  if (!text) return false;
  const head = text.replace(/\s+/g, " ").slice(0, 320);
  const hasArtifactSubject = /(需求说明书|需求文档|产品需求文档|PRD|画布)/i.test(head);
  if (!hasArtifactSubject) return false;

  return (
    /^(已生成|已完成|已写入|PRD\s*已生成|需求文档已生成|产品需求文档已生成)/i.test(head) ||
    /(请在右侧|可在右侧|右侧\s*(PRD\s*)?画布|画布(中)?(查看|继续|评审|修改)|继续评审|继续修改)/i.test(head)
  );
}

function sectionsToPlainText(sections: RequirementDocSection[]) {
  return sections
    .map((section) => {
      const blockText = section.blocks
        ?.map((block) => block.content?.trim())
        .filter(Boolean)
        .join("\n");
      return [section.title, section.content, blockText].filter(Boolean).join("\n");
    })
    .join("\n\n")
    .trim();
}

function mergeSummaryIntoPreviousDocument(
  conversationId: string,
  previousDocument: CurrentRequirementDocumentRecord,
  summary: string,
): RequirementDocumentDraft {
  const previousSections = toSections(previousDocument.sections);
  const normalizedSummary = summary.trim();
  const sections = normalizedSummary
    ? [
        {
          id: `section_change_${crypto.randomUUID()}`,
          title: "本次变更说明",
          type: "overview" as const,
          level: 2 as const,
          order: 1,
          content: normalizedSummary,
          sourcePaths: [],
        },
        ...previousSections.map((section, index) => ({
          ...section,
          order: index + 2,
        })),
      ]
    : previousSections;

  return {
    conversationId,
    title: previousDocument.title || "需求文档",
    sections: sections.length ? sections : markdownToSections(normalizedSummary, previousDocument.title || "需求文档"),
    knowledgeRefs: Array.isArray(previousDocument.knowledgeRefs)
      ? (previousDocument.knowledgeRefs as Array<Record<string, unknown>>)
      : [],
    assumptions: Array.isArray(previousDocument.assumptions)
      ? (previousDocument.assumptions as AssumptionReference[])
      : [],
    pendingQuestions: Array.isArray(previousDocument.pendingQuestions)
      ? (previousDocument.pendingQuestions as RequirementDocumentDraft["pendingQuestions"])
      : [],
    validationNotes: [
      ...(Array.isArray(previousDocument.validationNotes)
        ? previousDocument.validationNotes.map(String)
        : []),
      "DeerFlow 本轮仅返回修改摘要，已保留上一版 PRD 正文并追加变更说明。",
    ],
  };
}

function findArtifactText(
  artifacts: DeerFlowResolvedArtifact[],
  kinds: string[],
  contentTypes: string[],
): string | undefined {
  const byKind = artifacts.find((item) => kinds.includes(String(item.kind ?? "").toLowerCase()));
  if (byKind?.text) return cleanPersistedText(byKind.text);
  const byContentType = artifacts.find((item) => contentTypes.includes(String(item.contentType ?? "").toLowerCase()));
  if (byContentType?.text) return cleanPersistedText(byContentType.text);
  // 兜底：任何带 text 的 HTML/markdown artifact
  const fallback = artifacts.find((item) => {
    const ct = String(item.contentType ?? "").toLowerCase();
    const kind = String(item.kind ?? "").toLowerCase();
    return ct.includes("html") || ct.includes("markdown") || kind.includes("html") || kind.includes("markdown");
  });
  return fallback?.text ? cleanPersistedText(fallback.text) : undefined;
}

function findPrdArtifactText(artifacts: DeerFlowResolvedArtifact[]): string | undefined {
  const artifactText = artifacts.find((item) => {
    if (!item.text?.trim() || item.status === "failed") return false;
    const descriptor = [
      item.kind,
      item.title,
      item.contentType,
      item.path,
      item.artifactUrl,
    ].filter(Boolean).join(" ").toLowerCase();
    return descriptor.includes("prd") ||
      descriptor.includes("markdown") ||
      descriptor.includes("text/markdown") ||
      descriptor.endsWith(".md");
  })?.text;
  return artifactText ? cleanPersistedText(artifactText) : undefined;
}

function markdownToSections(markdown: string, title: string): RequirementDocSection[] {
  const text = markdown.trim();
  if (!text) {
    return [
      {
        id: "section_overview",
        title,
        type: "overview",
        level: 1,
        order: 1,
        content: title,
        sourcePaths: [],
      },
    ];
  }

  // 按 markdown 标题（# / ## / ###）切分为段落。
  const lines = text.split(/\r?\n/);
  const sections: RequirementDocSection[] = [];
  let current: { title: string; level: number; lines: string[] } | null = null;
  let order = 0;

  const flush = () => {
    if (!current) return;
    order += 1;
    sections.push({
      id: `section_${order}`,
      title: current.title,
      type: "overview",
      level: Math.min(Math.max(current.level, 1), 3) as RequirementDocSection["level"],
      order,
      content: current.lines.join("\n").trim(),
      sourcePaths: [],
    });
    current = null;
  };

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = { title: match[2].trim(), level: match[1].length, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      current = { title: title || "概述", level: 1, lines: [line] };
    }
  }
  flush();

  return sections.length
    ? sections
    : [
        {
          id: "section_overview",
          title,
          type: "overview",
          level: 1,
          order: 1,
          content: text,
          sourcePaths: [],
        },
      ];
}

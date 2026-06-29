import { Injectable, Logger } from "@nestjs/common";
import { ProductDesignStateStatus } from "@prisma/client";
import crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ProductDesignStateService } from "./product-design-state.service";
import { PrototypeService } from "./prototype.service";
import { RequirementDocumentService } from "./requirement-document.service";
import type {
  AssumptionReference,
  ProductDesignDraft,
  PrototypeArtifact,
  PrototypeArtifactDraft,
  PrototypeSpec,
  PrototypeTargetDevice,
  RequirementDocSection,
  RequirementDocument,
  RequirementDocumentDraft,
} from "./ai-vibe.types";
import type { DeerFlowFinalAction, DeerFlowResolvedArtifact } from "./deerflow-runtime.service";

/**
 * DeerFlow 落库桥接（审计 P0 根因修复）。
 *
 * runDeerFlowTurn 拿到 DeerFlow 的 finalAction 后，本服务按 type 把产物落库：
 * - review_prd → 保存 RequirementDocument + 写入 ProductDesignState.prdDocument
 * - review_prototype → 保存 PrototypeArtifact + PrototypeSpec + 写入 ProductDesignState.prototypeSpec
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
    private readonly stateService: ProductDesignStateService,
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
  ) {}

  async apply(input: {
    projectId: string;
    userId: string;
    runId: string;
    finalAction: DeerFlowFinalAction;
    artifacts: DeerFlowResolvedArtifact[];
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
      return this.applyReviewPrototype(input, raw);
    }
    return {};
  }

  private async applyReviewPrd(
    input: { projectId: string; userId: string; runId: string; finalAction: DeerFlowFinalAction; artifacts: DeerFlowResolvedArtifact[] },
    raw: Record<string, unknown> | undefined,
  ) {
    const stateDraft = this.buildProductDesignDraft(input.projectId, raw, input.userId);
    const state = await this.stateService.createDraft(input.projectId, stateDraft, {
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow review_prd：生成 PRD 前更新产品设计状态",
    });

    const documentDraft = this.buildRequirementDocumentDraft(input.projectId, raw, input.artifacts, input.finalAction.message);
    const document = await this.documentService.saveGeneratedDocument(state, documentDraft, {
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow 生成 PRD",
    });

    const updatedState = await this.stateService.attachGeneratedArtifacts(state.id, {
      prdDocument: document,
      status: ProductDesignStateStatus.doc_ready,
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow 生成 PRD，写入 ProductDesignState",
    });

    return { prdDocument: document, state: updatedState };
  }

  private async applyReviewPrototype(
    input: { projectId: string; userId: string; runId: string; finalAction: DeerFlowFinalAction; artifacts: DeerFlowResolvedArtifact[] },
    raw: Record<string, unknown> | undefined,
  ) {
    const state = await this.stateService.getCurrentState(input.projectId);
    if (!state) {
      throw new Error("PROTOTYPE_STATE_NOT_FOUND：生成原型前需要先有 ProductDesignState（通常先 review_prd）。");
    }

    const prototypeSpec = this.buildPrototypeSpec(state.projectId, state.id, state.version, raw);
    const artifactDraft = this.buildPrototypeArtifactDraft(input.projectId, raw, input.artifacts, input.finalAction.message);

    const result = await this.prototypeService.saveGeneratedPrototype(state, prototypeSpec, artifactDraft, {
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow 生成原型",
    });

    const updatedState = await this.stateService.attachGeneratedArtifacts(state.id, {
      prototypeSpec: result.prototypeSpec,
      status: ProductDesignStateStatus.prototype_ready,
      userId: input.userId,
      runId: input.runId,
      reason: "DeerFlow 生成原型，写入 ProductDesignState",
    });

    return { prototypeArtifact: result.artifact, state: updatedState };
  }

  private buildProductDesignDraft(
    projectId: string,
    raw: Record<string, unknown> | undefined,
    userId: string,
  ): ProductDesignDraft {
    const stateDraft = asRecord(raw?.productDesignStateDraft);
    const assumptions = toAssumptionReferences(raw?.assumptions);
    const knowledgeRefs = toKnowledgeRefRecords(raw?.knowledgeRefsUsed);
    return {
      projectId,
      title: toStringValue(stateDraft?.title) || "产品需求方案",
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
    } as ProductDesignDraft;
  }

  private buildRequirementDocumentDraft(
    projectId: string,
    raw: Record<string, unknown> | undefined,
    artifacts: DeerFlowResolvedArtifact[],
    fallbackMessage: string,
  ): RequirementDocumentDraft {
    const prdDraft = asRecord(raw?.prdDocumentDraft);
    const title = toStringValue(prdDraft?.title) || "需求文档";
    const sections = toSections(prdDraft?.sections);

    if (sections.length > 0) {
      return {
        projectId,
        title,
        sections,
        knowledgeRefs: toKnowledgeRefRecords(raw?.knowledgeRefsUsed),
        assumptions: toAssumptionReferences(raw?.assumptions),
        pendingQuestions: [],
        validationNotes: [],
      };
    }

    // DeerFlow 通常把 PRD 正文以 markdown artifact 形式产出；尝试从中解析段落。
    const markdown = findArtifactText(artifacts, ["prd_markdown", "prd", "markdown"], ["text/markdown", "text/plain"]);
    const body = markdown ?? fallbackMessage;
    return {
      projectId,
      title,
      sections: markdownToSections(body, title),
      knowledgeRefs: toKnowledgeRefRecords(raw?.knowledgeRefsUsed),
      assumptions: toAssumptionReferences(raw?.assumptions),
      pendingQuestions: [],
      validationNotes: [],
    };
  }

  private buildPrototypeSpec(
    projectId: string,
    stateId: string,
    stateVersion: number,
    raw: Record<string, unknown> | undefined,
  ): PrototypeSpec {
    const spec = asRecord(raw?.prototypeSpec);
    const id = crypto.randomUUID();
    return {
      id,
      projectId,
      productDesignStateId: stateId,
      productDesignStateVersion: stateVersion,
      title: toStringValue(spec?.title) || "原型",
      targetDevice: toTargetDevice(spec?.targetDevice),
      styleGuide: (toRecord(spec?.styleGuide) ?? {}) as PrototypeSpec["styleGuide"],
      pages: toArray(spec?.pages) as PrototypeSpec["pages"],
      navigation: toArray(spec?.navigation) as PrototypeSpec["navigation"],
      interactions: toArray(spec?.interactions) as PrototypeSpec["interactions"],
      assumptions: toAssumptionReferences(raw?.assumptions),
      knowledgeRefs: toKnowledgeRefRecords(raw?.knowledgeRefsUsed),
      generatedByRunId: undefined,
    };
  }

  private buildPrototypeArtifactDraft(
    projectId: string,
    raw: Record<string, unknown> | undefined,
    artifacts: DeerFlowResolvedArtifact[],
    fallbackMessage: string,
  ): PrototypeArtifactDraft {
    const html = findArtifactText(artifacts, ["prototype_html", "html", "prototype"], ["text/html"]);
    return {
      projectId,
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

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function toArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: String(item) }));
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

function toKnowledgeRefRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const title = typeof item === "string" ? item : toStringValue(asRecord(item)?.title) ?? toStringValue(asRecord(item)?.path) ?? `知识引用 ${index + 1}`;
    return { id: `knowledge_ref_${index + 1}`, title, knowledgeId: `knowledge_${index + 1}` };
  });
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
      blocks: Array.isArray(record.blocks) ? (record.blocks as RequirementDocSection["blocks"]) : undefined,
      sourcePaths: Array.isArray(record.sourcePaths) ? (record.sourcePaths as string[]) : [],
    });
  });
  return sections;
}

function findArtifactText(
  artifacts: DeerFlowResolvedArtifact[],
  kinds: string[],
  contentTypes: string[],
): string | undefined {
  const byKind = artifacts.find((item) => kinds.includes(String(item.kind ?? "").toLowerCase()));
  if (byKind?.text) return byKind.text;
  const byContentType = artifacts.find((item) => contentTypes.includes(String(item.contentType ?? "").toLowerCase()));
  if (byContentType?.text) return byContentType.text;
  // 兜底：任何带 text 的 HTML/markdown artifact
  const fallback = artifacts.find((item) => {
    const ct = String(item.contentType ?? "").toLowerCase();
    const kind = String(item.kind ?? "").toLowerCase();
    return ct.includes("html") || ct.includes("markdown") || kind.includes("html") || kind.includes("markdown");
  });
  return fallback?.text;
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

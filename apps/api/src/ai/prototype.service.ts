import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  KnowledgeCandidateSource,
  KnowledgeType,
  Prisma,
  ConversationDesignStateStatus,
  ConversationStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  RequirementDocumentStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeCandidateService } from "../knowledge/knowledge-candidate.service";
import DOMPurify from "isomorphic-dompurify";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  PrototypeComponentSpec,
  ConversationDesignState,
  PrototypeArtifact,
  PrototypeArtifactDraft,
  PrototypePageSpec,
  PrototypeSpec,
  PrototypeVersion,
} from "./ai-vibe.types";
import { ConversationDesignStateService } from "./conversation-design-state.service";
import { QaService } from "./qa.service";
import type { KnowledgeCandidateDraft } from "../knowledge/knowledge.types";

type PrototypeSpecRecord = {
  id: string;
  conversationId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
  title: string;
  targetDevice: PrototypeTargetDevice;
  styleGuide: unknown;
  pages: unknown;
  navigation: unknown;
  interactions: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  generatedByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrototypeArtifactRecord = {
  id: string;
  conversationId: string;
  prototypeSpecId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
  title: string;
  status: PrototypeArtifactStatus;
  htmlContent: string | null;
  entryFilePath: string | null;
  previewUrl: string | null;
  targetDevice: PrototypeTargetDevice;
  pageCount: number;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrototypeStateNode = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  layout: Record<string, unknown>;
  children: PrototypeStateNode[];
};

@Injectable()
export class PrototypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ConversationDesignStateService,
    @Optional()
    private readonly knowledgeCandidateService?: KnowledgeCandidateService,
    @Optional()
    private readonly qaService?: QaService,
  ) {}

  async saveGeneratedPrototype(
    state: ConversationDesignState,
    prototypeSpec: PrototypeSpec,
    draft: PrototypeArtifactDraft,
    options: { userId: string; runId?: string; reason?: string },
  ) {
    // sec-1：用 DOMPurify allowlist 净化后再存储（替换可绕过的正则黑名单）。
    // 净化后总有内容则 ready；空内容（如仅含被剥离的脚本）才 failed。
    const rawHtml = draft.htmlContent ?? draft.html ?? "";
    const htmlContent = sanitizePrototypeDocumentHtml(rawHtml, draft.title ?? prototypeSpec.title);
    const hasContent = htmlContent.trim().length > 0;

    const result = await this.prisma.$transaction(async (tx) => {
      return this.saveGeneratedPrototypeInTransaction(
        tx,
        state,
        prototypeSpec,
        draft,
        options,
        htmlContent,
        hasContent,
      );
    });
    if (!result.hasContent) {
      throw new BadRequestException("PROTOTYPE_HTML_EMPTY_AFTER_SANITIZE");
    }
    return {
      prototypeSpec: result.prototypeSpec,
      artifact: result.artifact,
      version: result.version,
    };
  }

  async saveGeneratedPrototypeInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    state: ConversationDesignState,
    prototypeSpec: PrototypeSpec,
    draft: PrototypeArtifactDraft,
    options: { userId: string; runId?: string; reason?: string },
    htmlContent: string,
    hasContent: boolean,
  ) {
    const specRecord = await tx.prototypeSpecRecord.create({
      data: {
        id: prototypeSpec.id,
        conversationId: state.conversationId,
        conversationDesignStateId: state.id,
        conversationDesignStateVersion: state.version,
        title: prototypeSpec.title,
        targetDevice: toPrismaTargetDevice(prototypeSpec.targetDevice),
        styleGuide: toInputJson(prototypeSpec.styleGuide),
        pages: toInputJson(prototypeSpec.pages),
        navigation: toInputJson(prototypeSpec.navigation),
        interactions: toInputJson(prototypeSpec.interactions),
        assumptions: toInputJson(prototypeSpec.assumptions),
        knowledgeRefs: toInputJson(prototypeSpec.knowledgeRefs),
        generatedByRunId: options.runId ?? prototypeSpec.generatedByRunId,
      },
    });

    const artifactRecord = await tx.prototypeArtifact.create({
      data: {
        conversationId: state.conversationId,
        prototypeSpecId: specRecord.id,
        conversationDesignStateId: state.id,
        conversationDesignStateVersion: state.version,
        title: draft.title ?? prototypeSpec.title,
        status: hasContent
          ? PrototypeArtifactStatus.ready
          : PrototypeArtifactStatus.failed,
        htmlContent: hasContent ? htmlContent : null,
        entryFilePath: draft.entryFilePath ?? draft.entryFile ?? "index.html",
        previewUrl: draft.previewUrl,
        targetDevice: toPrismaTargetDevice(
          draft.targetDevice ?? prototypeSpec.targetDevice,
        ),
        pageCount: draft.pageCount ?? (prototypeSpec.pages.length || 1),
        generatedByRunId: options.runId ?? draft.generatedByRunId,
        errorMessage: hasContent
          ? draft.errorMessage
          : "PROTOTYPE_HTML_EMPTY_AFTER_SANITIZE",
        createdBy: options.userId,
        updatedBy: options.userId,
      },
    });

    const spec = this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord);
    const artifact = this.toArtifactItem(
      artifactRecord as PrototypeArtifactRecord,
    );
    if (!hasContent) {
      const version = await this.createVersion(
        spec,
        artifact,
        options.userId,
        "原型生成失败：净化后无 HTML 内容",
        tx,
      );
      return { prototypeSpec: spec, artifact, version, hasContent };
    }

    await tx.conversation.update({
      where: { id: state.conversationId },
      data: { currentPrototypeArtifactId: artifact.id },
    });
    const version = await this.createVersion(
      spec,
      artifact,
      options.userId,
      options.reason ?? "HTML 原型生成完成",
      tx,
    );
    return { prototypeSpec: spec, artifact, version, hasContent };
  }

  async getCurrentForUser(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, {
      allowArchived: true,
    });
    return this.getCurrentForConversation(conversationId);
  }

  async getCurrentForConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      conversation.deletedAt ||
      conversation.status === ConversationStatus.deleted
    ) {
      throw new NotFoundException("会话不存在");
    }
    const state = await this.stateService.getCurrentState(conversationId);
    const artifact = await this.getCurrentPrototypeArtifactForState(
      conversationId,
      conversation.currentPrototypeArtifactId,
      state,
    );
    return {
      artifact: artifact
        ? this.toArtifactItem(artifact as PrototypeArtifactRecord)
        : null,
      conversationDesignState: state ?? null,
    };
  }

  async getPrototypeStateForUser(
    user: AuthenticatedUser,
    input: { conversationId: string; artifactId?: string },
  ) {
    const conversation = await this.assertConversationAccess(
      user,
      input.conversationId,
      { allowArchived: true },
    );
    const state = input.artifactId
      ? undefined
      : await this.stateService.getCurrentState(input.conversationId);
    const artifact = input.artifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: input.artifactId, conversationId: input.conversationId },
        })
      : await this.getCurrentPrototypeArtifactForState(
          input.conversationId,
          conversation.currentPrototypeArtifactId,
          state,
        );

    if (!artifact) return { prototypeState: null };
    const specRecord = await this.prisma.prototypeSpecRecord.findUnique({
      where: { id: artifact.prototypeSpecId },
    });
    const artifactItem = this.toArtifactItem(
      artifact as PrototypeArtifactRecord,
    );
    const spec = specRecord
      ? this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord)
      : undefined;

    return {
      prototypeState: {
        id: artifactItem.id,
        conversationId: artifactItem.conversationId,
        artifactId: artifactItem.id,
        prototypeSpecId: artifactItem.prototypeSpecId,
        conversationDesignStateId: artifactItem.conversationDesignStateId,
        conversationDesignStateVersion:
          artifactItem.conversationDesignStateVersion,
        version: artifactItem.conversationDesignStateVersion,
        updatedAt: artifactItem.updatedAt,
        root: prototypeStateRoot(spec, artifactItem),
        pages: spec?.pages ?? [],
        interactions: spec?.interactions ?? [],
        sourceStateRef: {
          conversationDesignStateId: artifactItem.conversationDesignStateId,
          version: artifactItem.conversationDesignStateVersion,
        },
      },
      prototypeSpec: spec,
      artifact: artifactItem,
      conversationDesignState: state ?? null,
    };
  }

  async getArtifactForUser(user: AuthenticatedUser, artifactId: string) {
    const artifact = await this.getAccessibleArtifact(user, artifactId);
    const prototypeSpec = await this.prisma.prototypeSpecRecord.findUnique({
      where: { id: artifact.prototypeSpecId },
    });
    return {
      artifact: this.toArtifactItem(artifact as PrototypeArtifactRecord),
      prototypeSpec: prototypeSpec
        ? this.toPrototypeSpecItem(prototypeSpec as PrototypeSpecRecord)
        : undefined,
    };
  }

  async getPreviewHtmlForUser(user: AuthenticatedUser, artifactId: string) {
    const artifact = await this.getAccessibleArtifact(user, artifactId);
    if (
      artifact.status !== PrototypeArtifactStatus.ready ||
      !artifact.htmlContent
    ) {
      throw new BadRequestException("PROTOTYPE_PREVIEW_NOT_READY");
    }
    // sec-1：读取时再净化一遍（防御历史未净化数据），并返回可独立渲染的 HTML 文档。
    return sanitizePrototypeDocumentHtml(artifact.htmlContent, artifact.title);
  }

  async listVersionsForUser(user: AuthenticatedUser, artifactId: string) {
    await this.getAccessibleArtifact(user, artifactId);
    const items = await this.prisma.prototypeVersion.findMany({
      where: { artifactId },
      orderBy: { version: "desc" },
    });
    return {
      items: items.map((item) => this.toVersionItem(item)),
    };
  }

  async confirmForUser(
    user: AuthenticatedUser,
    artifactId: string,
    reason?: string,
  ) {
    const current = await this.getAccessibleArtifact(user, artifactId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    if (
      current.status !== PrototypeArtifactStatus.ready ||
      !current.htmlContent
    ) {
      throw new BadRequestException("PROTOTYPE_CONFIRM_NOT_READY");
    }
    const qaGate = this.qaService
      ? await this.qaService.assertGateAllows(
          user,
          current.conversationId,
          "confirm_artifacts",
        )
      : undefined;
    const specRecord = await this.prisma.prototypeSpecRecord.findUniqueOrThrow({
      where: { id: current.prototypeSpecId },
    });
    const updated = await this.prisma.prototypeArtifact.update({
      where: { id: artifactId },
      data: { updatedBy: user.id },
    });
    const spec = this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord);
    const artifact = this.toArtifactItem(updated as PrototypeArtifactRecord);
    const version = await this.createVersion(
      spec,
      artifact,
      user.id,
      reason ?? "用户确认原型",
    );
    const conversationDesignState =
      await this.stateService.attachGeneratedArtifacts(
        artifact.conversationDesignStateId,
        {
          prototypeSpec: spec,
          status: ConversationDesignStateStatus.confirmed,
          userId: user.id,
          reason: `${reason ?? "用户确认原型"}，同步原型确认状态到 ConversationDesignState`,
        },
      );
    const knowledgeCandidates =
      qaGate && !qaGate.allowPersistKnowledge
        ? { items: [], qaGate }
        : await this.extractKnowledgeCandidatesAfterConfirm(
            user.id,
            spec,
            artifact,
          );
    return {
      artifact,
      version,
      conversationDesignState,
      knowledgeCandidates,
      qaGate,
    };
  }

  private async extractKnowledgeCandidatesAfterConfirm(
    userId: string,
    spec: PrototypeSpec,
    artifact: PrototypeArtifact,
  ) {
    void userId;
    if (!this.knowledgeCandidateService) return { items: [] };
    return this.knowledgeCandidateService.createMany(
      artifact.conversationId,
      prototypeToKnowledgeCandidates(spec, artifact),
      {
        source: KnowledgeCandidateSource.prototype,
        sourceRefId: artifact.id,
        runId: artifact.generatedByRunId,
      },
    );
  }

  private async createVersion(
    prototypeSpec: PrototypeSpec,
    artifact: PrototypeArtifact,
    createdBy: string,
    reason: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PrototypeVersion> {
    const client = tx ?? this.prisma;
    const latest = await client.prototypeVersion.findFirst({
      where: { artifactId: artifact.id },
      orderBy: { version: "desc" },
    });
    const version = await client.prototypeVersion.create({
      data: {
        conversationId: artifact.conversationId,
        artifactId: artifact.id,
        version: (latest?.version ?? 0) + 1,
        prototypeSpecSnapshot: toInputJson(prototypeSpec),
        artifactSnapshot: toInputJson(artifact),
        reason,
        createdBy,
      },
    });
    return this.toVersionItem(version);
  }

  private async getCurrentPrototypeArtifactForState(
    conversationId: string,
    currentPrototypeArtifactId: string | null | undefined,
    state?: ConversationDesignState,
  ) {
    const artifact = currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: currentPrototypeArtifactId, conversationId },
        })
      : await this.prisma.prototypeArtifact.findFirst({
          where: { conversationId },
          orderBy: { updatedAt: "desc" },
        });

    if (!artifact || !state) return artifact;
    if (isArtifactFromCurrentState(artifact as PrototypeArtifactRecord, state))
      return artifact;
    return null;
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      conversation.deletedAt ||
      conversation.status === ConversationStatus.deleted
    ) {
      throw new NotFoundException("会话不存在");
    }
    if (
      !options.allowArchived &&
      conversation.status === ConversationStatus.archived
    ) {
      throw new ForbiddenException("会话已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("PROTOTYPE_ARTIFACT_FORBIDDEN");
    }
    return conversation;
  }

  private async getAccessibleArtifact(
    user: AuthenticatedUser,
    artifactId: string,
  ) {
    const artifact = await this.prisma.prototypeArtifact.findUnique({
      where: { id: artifactId },
      include: { conversation: true },
    });
    if (
      !artifact ||
      artifact.conversation.deletedAt ||
      artifact.conversation.status === ConversationStatus.deleted
    ) {
      throw new NotFoundException("PROTOTYPE_ARTIFACT_NOT_FOUND");
    }
    if (
      user.role !== UserRole.admin &&
      artifact.conversation.ownerId !== user.id
    ) {
      throw new ForbiddenException("PROTOTYPE_ARTIFACT_FORBIDDEN");
    }
    return artifact;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户会话原型");
    }
  }

  private toPrototypeSpecItem(record: PrototypeSpecRecord): PrototypeSpec {
    return {
      id: record.id,
      conversationId: record.conversationId,
      conversationDesignStateId: record.conversationDesignStateId,
      conversationDesignStateVersion: record.conversationDesignStateVersion,
      title: record.title,
      targetDevice: record.targetDevice,
      styleGuide: asRecord(record.styleGuide) as PrototypeSpec["styleGuide"],
      pages: Array.isArray(record.pages)
        ? (record.pages as PrototypeSpec["pages"])
        : [],
      navigation: Array.isArray(record.navigation)
        ? (record.navigation as PrototypeSpec["navigation"])
        : [],
      interactions: Array.isArray(record.interactions)
        ? (record.interactions as PrototypeSpec["interactions"])
        : [],
      assumptions: Array.isArray(record.assumptions)
        ? (record.assumptions as PrototypeSpec["assumptions"])
        : [],
      knowledgeRefs: Array.isArray(record.knowledgeRefs)
        ? (record.knowledgeRefs as Array<Record<string, unknown>>)
        : [],
      generatedByRunId: record.generatedByRunId ?? undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toArtifactItem(record: PrototypeArtifactRecord): PrototypeArtifact {
    return {
      id: record.id,
      conversationId: record.conversationId,
      prototypeSpecId: record.prototypeSpecId,
      conversationDesignStateId: record.conversationDesignStateId,
      conversationDesignStateVersion: record.conversationDesignStateVersion,
      title: record.title,
      status: record.status,
      htmlContent: record.htmlContent ?? undefined,
      entryFilePath: record.entryFilePath ?? undefined,
      previewUrl: record.previewUrl ?? undefined,
      targetDevice: record.targetDevice,
      pageCount: record.pageCount,
      generatedByRunId: record.generatedByRunId ?? undefined,
      errorMessage: record.errorMessage ?? undefined,
      createdBy: record.createdBy,
      updatedBy: record.updatedBy ?? undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      html: record.htmlContent ?? undefined,
      entryFile: record.entryFilePath ?? undefined,
      assets: [],
    };
  }

  private toVersionItem(version: {
    id: string;
    conversationId: string;
    artifactId: string;
    version: number;
    prototypeSpecSnapshot: unknown;
    artifactSnapshot: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }): PrototypeVersion {
    return {
      id: version.id,
      conversationId: version.conversationId,
      artifactId: version.artifactId,
      version: version.version,
      prototypeSpecSnapshot: version.prototypeSpecSnapshot as PrototypeSpec,
      artifactSnapshot: version.artifactSnapshot as PrototypeArtifact,
      reason: version.reason ?? undefined,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }
}

function isArtifactFromCurrentState(
  artifact: PrototypeArtifactRecord,
  state: ConversationDesignState,
) {
  if (artifact.conversationDesignStateId !== state.id) return false;
  if (state.prototypeSpec?.id)
    return artifact.prototypeSpecId === state.prototypeSpec.id;
  return artifact.conversationDesignStateVersion === state.version;
}

function prototypeStateRoot(
  spec: PrototypeSpec | undefined,
  artifact: PrototypeArtifact,
): PrototypeStateNode {
  return {
    id: artifact.id,
    type: "prototype",
    props: {
      title: artifact.title,
      artifactId: artifact.id,
      prototypeSpecId: artifact.prototypeSpecId,
      status: artifact.status,
      sourceStateRef: artifact.conversationDesignStateId,
    },
    layout: {
      targetDevice: artifact.targetDevice,
      pageCount: artifact.pageCount,
    },
    children: spec?.pages.map(prototypePageNode) ?? [],
  };
}

function prototypePageNode(page: PrototypePageSpec): PrototypeStateNode {
  return {
    id: page.id,
    type: "page",
    props: {
      name: page.name,
      route: page.route,
      description: page.description,
      sourceStateRef: page.sourcePageId,
      sourcePaths: page.sourcePaths,
    },
    layout: {
      device: page.device,
      layout: page.layout,
      order: page.order,
    },
    children: page.components.map(prototypeComponentNode),
  };
}

function prototypeComponentNode(
  component: PrototypeComponentSpec,
): PrototypeStateNode {
  return {
    id: component.id,
    type: component.type,
    props: {
      name: component.name,
      description: component.description,
      content: component.content,
      sourcePaths: component.sourcePaths,
      states: component.states,
      interactions: component.interactions,
      ...(component.props ?? {}),
    },
    layout: {},
    children: (component.children ?? []).map(prototypeComponentNode),
  };
}

function prototypeToKnowledgeCandidates(
  spec: PrototypeSpec,
  artifact: PrototypeArtifact,
): KnowledgeCandidateDraft[] {
  const drafts: KnowledgeCandidateDraft[] = [];
  const overview = [
    `# ${spec.title}`,
    `目标设备：${spec.targetDevice}`,
    `页面数量：${spec.pages.length}`,
    spec.pages
      .map((page) => `- ${page.name}${page.route ? `（${page.route}）` : ""}`)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (overview.length >= 20) {
    drafts.push({
      title: `${spec.title} 原型方案`,
      content: overview,
      summary: `${spec.title} 的原型结构与页面清单。`,
      suggestedType: KnowledgeType.prototype_package,
      suggestedTags: ["prototype", "prototype_package", spec.targetDevice],
      confidence: 0.78,
      sourcePath: "prototype",
      reason: "从用户确认后的原型产物抽取整体原型知识候选。",
    });
  }

  for (const page of spec.pages) {
    const content = prototypePageKnowledgeContent(page);
    if (content.length < 20) continue;
    drafts.push({
      title: `${spec.title} - ${page.name}`,
      content,
      summary: page.description ?? `${page.name} 页面原型结构。`,
      suggestedType: KnowledgeType.prototype_page,
      suggestedTags: ["prototype", "prototype_page", page.device, page.layout],
      confidence: 0.82,
      sourcePath: `pages.${page.id}`,
      reason: "从用户确认后的原型页面抽取页面级知识候选。",
    });
  }

  if (!drafts.length && artifact.htmlContent) {
    drafts.push({
      title: `${artifact.title} 原型 HTML`,
      content: artifact.htmlContent.slice(0, 4000),
      summary: `${artifact.title} 的 HTML 原型快照。`,
      suggestedType: KnowledgeType.prototype_snapshot,
      suggestedTags: ["prototype", "html"],
      confidence: 0.6,
      sourcePath: "htmlContent",
      reason: "从用户确认后的原型 HTML 抽取快照候选。",
    });
  }
  return drafts;
}

function prototypePageKnowledgeContent(page: PrototypePageSpec) {
  const components = page.components
    .map(
      (component) =>
        `- ${component.name}：${component.description ?? component.content ?? component.type}`,
    )
    .join("\n");
  const states = page.states
    ?.map((state) => `- ${state.name}：${state.description}`)
    .join("\n");
  return [
    `# ${page.name}`,
    page.route ? `路由：${page.route}` : "",
    `设备：${page.device}`,
    `布局：${page.layout}`,
    page.description ?? "",
    components ? `## 组件\n${components}` : "",
    states ? `## 状态\n${states}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * Use a DOMPurify allowlist for generated prototype HTML. Inline scripts are
 * allowed only inside the opaque preview sandbox; cross-frame, network, and
 * external-script capabilities remain blocked here and by CSP.
 */
export function sanitizePrototypeHtml(html: string): string {
  const removeUnsafeScript = (currentNode: Node, hookEvent: { tagName: string }) => {
    if (hookEvent.tagName !== "script") return;
    const element = currentNode as Element;
    const source = element.textContent ?? "";
    const unsafe = element.hasAttribute("src")
      || /(?:\b(?:window\.)?(?:parent|top|opener)\b|postMessage\s*\(|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|\bimport\s*\(|\beval\s*\(|\bFunction\s*\()/i.test(source);
    if (unsafe) {
      element.removeAttribute("src");
      element.textContent = "";
    }
  };
  DOMPurify.addHook("uponSanitizeElement", removeUnsafeScript);
  try {
    return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ALLOWED_TAGS: [
      "html",
      "head",
      "body",
      "title",
      "meta",
      "link",
      "style",
      "script",
      "a",
      "abbr",
      "b",
      "blockquote",
      "br",
      "caption",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "figcaption",
      "figure",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "ins",
      "kbd",
      "li",
      "mark",
      "ol",
      "p",
      "pre",
      "q",
      "s",
      "samp",
      "small",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "time",
      "tr",
      "u",
      "ul",
      "var",
      "wbr",
      "button",
      "label",
      "input",
      "select",
      "option",
      "textarea",
      "fieldset",
      "legend",
      "nav",
      "header",
      "footer",
      "main",
      "section",
      "article",
      "aside",
      "dialog",
    ],
    ALLOWED_ATTR: [
      "class",
      "id",
      "style",
      "charset",
      "content",
      "href",
      "src",
      "alt",
      "title",
      "type",
      "name",
      "value",
      "placeholder",
      "for",
      "colspan",
      "rowspan",
      "target",
      "rel",
      "width",
      "height",
      "disabled",
      "checked",
      "selected",
      "required",
      "aria-label",
      "aria-hidden",
      "role",
      "data-component-id",
      "data-page-id",
      "data-action",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ["data-component-id", "data-page-id", "data-action"],
    FORBID_TAGS: ["iframe", "object", "embed", "base", "form"],
    FORBID_ATTR: [
      "onerror",
      "onclick",
      "onload",
      "onmouseover",
      "onmouseout",
      "onsubmit",
      "onchange",
      "oninput",
      "onfocus",
      "onblur",
    ],
    });
  } finally {
    DOMPurify.removeHook("uponSanitizeElement", removeUnsafeScript);
  }
}

export function sanitizePrototypeDocumentHtml(
  html: string,
  title = "prototype",
): string {
  const sanitized = sanitizePrototypeHtml(html).trim();
  const fallbackTitle = escapeHtml(title);
  const documentHtml = !sanitized
    ? `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${fallbackTitle}</title></head><body></body></html>`
    : /^<!doctype\s+html/i.test(sanitized)
      ? sanitized
      : /^<html[\s>]/i.test(sanitized)
        ? `<!doctype html>${sanitized}`
        : `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${fallbackTitle}</title></head><body>${sanitized}</body></html>`;
  return ensurePrototypeInteractionFallback(
    ensurePrototypeDocumentHead(documentHtml, fallbackTitle),
  );
}

function ensurePrototypeDocumentHead(html: string, escapedTitle: string) {
  let output = html;
  if (!/<head[\s>]/i.test(output)) {
    output = output.replace(/<html([^>]*)>/i, `<html$1><head></head>`);
  }
  if (!/<meta\s+charset=/i.test(output)) {
    output = output.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">`);
  }
  if (!/<title[\s>]/i.test(output)) {
    output = output.replace(/<head([^>]*)>/i, `<head$1><title>${escapedTitle}</title>`);
  }
  return output;
}

function ensurePrototypeInteractionFallback(html: string) {
  if (/<script\b[^>]*id=["']aipw-prototype-interaction-fallback["']/i.test(html)) {
    return html;
  }
  const script = `<script id="aipw-prototype-interaction-fallback">
(() => {
  const keyAction = /保存|预览|提交|审核|发布|下线|签到|领取|登录|确认|重试|补偿|导出|上传|删除|新增|创建|发送|搜索|查询/;
  const messages = [["保存","草稿已保存"],["预览","预览已更新"],["提交","已提交审核"],["审核","审核操作已完成"],["发布","已发布"],["下线","已下线"],["签到","签到成功"],["领取","领取成功"],["登录","登录操作已完成"],["确认","已确认"],["重试","重试已发起"],["补偿","补偿任务已发起"],["导出","导出任务已创建"],["上传","上传操作已完成"],["删除","删除操作已完成"],["新增","已新增"],["创建","已创建"],["发送","已发送"],["搜索","搜索已完成"],["查询","查询已完成"]];
  let status = document.getElementById("aipw-prototype-action-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "aipw-prototype-action-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.style.position = "fixed";
    status.style.right = "16px";
    status.style.bottom = "16px";
    status.style.zIndex = "2147483647";
    status.style.padding = "10px 14px";
    status.style.borderRadius = "6px";
    status.style.background = "#1f2937";
    status.style.color = "#ffffff";
    status.style.boxShadow = "0 6px 20px rgba(0,0,0,.18)";
    status.style.display = "none";
    document.body.appendChild(status);
  }
  document.querySelectorAll("button").forEach((button) => {
    const label = (button.textContent || "").trim();
    if (!keyAction.test(label) || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    button.addEventListener("click", () => {
      const match = messages.find(([keyword]) => label.includes(keyword));
      status.textContent = match ? match[1] : label + "操作已完成";
      status.style.display = "block";
    });
  });
})();
</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
  return `${html}${script}`;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function toPrismaTargetDevice(value: string): PrototypeTargetDevice {
  if (value === PrototypeTargetDevice.desktop)
    return PrototypeTargetDevice.desktop;
  if (value === PrototypeTargetDevice.mobile)
    return PrototypeTargetDevice.mobile;
  return PrototypeTargetDevice.both;
}

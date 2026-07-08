import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import type { RuntimeAttachmentFile } from "../files/file.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type { ExternalResearchContext } from "./external-research.service";

type DeerFlowToolCall = {
  id: string;
  name: string;
  args?: unknown;
};

export type DeerFlowRuntimeEvent = {
  event: string;
  data: unknown;
  content?: string;
  toolName?: string;
  /** Phase 2 透明化：结构化工具调用（全部，不只首个）、工具返回、消息角色、增量文本、节点。 */
  toolCalls?: DeerFlowToolCall[];
  toolCallId?: string;
  toolResult?: string;
  messageRole?: "assistant" | "tool" | "system" | "human" | "unknown";
  chunk?: string;
  /** 模型推理思维链（reasoning_content / thinking / <think>），已 delta 化，独立于正文 chunk。 */
  reasoning?: string;
  nodeId?: string;
  nodeName?: string;
};

export type DeerFlowFinalAction = {
  type: "answer" | "review_prd" | "review_prototype" | "ask_clarification" | "download_export";
  message: string;
  intent?: string;
  requirementMode?: "historical_extension" | "new_capability" | "brand_new_system" | "one_sentence_completion";
  knowledgeRefsUsed?: string[];
  externalRefsUsed?: string[];
  enrichmentNotes?: string[];
  externalResearchStatus?: string;
  artifacts?: DeerFlowArtifactReference[];
  raw?: unknown;
  /** 是否成功解析出 final action JSON 块。false 表示 DeerFlow 未产出可识别动作（静默降级为 answer）。 */
  parsed: boolean;
};

export type DeerFlowArtifactReference = {
  kind?: string;
  title?: string;
  path?: string;
  artifactUrl?: string;
  contentType?: string;
  metadata?: unknown;
};

export type DeerFlowResolvedArtifact = DeerFlowArtifactReference & {
  path: string;
  artifactUrl: string;
  status: "fetched" | "skipped" | "failed";
  size?: number;
  text?: string;
  errorMessage?: string;
};

type DeerFlowUploadedFile = {
  fileId: string;
  fileName: string;
  fileType: string;
  size: number;
  deerFlowFile: {
    filename?: string;
    size?: string;
    path?: string;
    virtualPath?: string;
    artifactUrl?: string;
    markdownFile?: string;
    markdownPath?: string;
    markdownVirtualPath?: string;
    markdownArtifactUrl?: string;
  };
};

export type DeerFlowTurnResult = {
  threadId: string;
  assistantText: string;
  finalAction: DeerFlowFinalAction;
  uploads: DeerFlowUploadedFile[];
  artifacts: DeerFlowResolvedArtifact[];
  rawEvents: DeerFlowRuntimeEvent[];
  finalState?: unknown;
};

type DeerFlowRunInput = {
  conversationId: string;
  userId: string;
  message: string;
  runId: string;
  attachments?: unknown[];
  attachmentFiles?: RuntimeAttachmentFile[];
  deerFlowUploads?: DeerFlowUploadedFile[];
  selectedRegion?: unknown;
  selectedModelName?: string;
  previewMode?: string;
  resumeReason?: string;
  conversationDesignState?: unknown;
  /** knowledge-core-2：生成路径注入的知识库召回（标题/摘要/内容/类型），让 DeerFlow 按知识基线产出 */
  knowledgeContext?: DeerFlowKnowledgeReference[];
  /** API 侧安全抓取的公开资料补充证据，只包含标题、URL、简短归纳和抓取状态，不包含网页全文。 */
  externalResearchContext?: ExternalResearchContext;
  signal?: AbortSignal;
  onEvent?: (event: DeerFlowRuntimeEvent) => Promise<void> | void;
};

/** 注入 DeerFlow 上下文的知识引用（与 knowledge.types 的 KnowledgeReference 对齐的最小子集）。 */
export type DeerFlowKnowledgeReference = {
  id: string;
  title: string;
  snippet?: string;
  content: string;
  type?: string;
  score?: number;
  semanticScore?: number;
  reason?: string;
  relatedPath?: string;
  visualAssets?: Array<{
    kind: "prototype_snapshot" | "image";
    title?: string;
    path: string;
    note?: string;
  }>;
};

type ThreadCreateResponse = {
  thread_id?: string;
  threadId?: string;
};

type UploadFilesResponse = {
  success?: boolean;
  files?: unknown[];
  message?: string;
};

@Injectable()
export class DeerFlowRuntimeService {
  constructor(private readonly prisma: PrismaService) {}

  isEnabled() {
    return readBooleanEnv("DEERFLOW_ENABLED", false);
  }

  async runTurn(input: DeerFlowRunInput): Promise<DeerFlowTurnResult> {
    let threadId = await this.ensureThread(input);
    let uploads = await this.uploadAttachments(threadId, input.userId, input.attachmentFiles ?? [], input.signal);
    let runInput = { ...input, deerFlowUploads: uploads };
    const rawEvents: DeerFlowRuntimeEvent[] = [];
    let assistantText = "";
    let reasoningText = "";
    let finalState: unknown;

    if (uploads.length) {
      await input.onEvent?.({
        event: "gateway-upload",
        data: { uploads },
        content: `已同步 ${uploads.length} 个附件到 DeerFlow。`,
      });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.streamRun(threadId, runInput, async (event) => {
          let eventForUi = event;
          if (isAssistantTextEvent(event) && event.content) {
            const delta = assistantTextDelta(assistantText, event.content);
            assistantText += delta;
            eventForUi = { ...eventForUi, content: delta, chunk: delta };
          }
          if (event.reasoning) {
            const reasoningDelta = assistantTextDelta(reasoningText, event.reasoning);
            reasoningText += reasoningDelta;
            eventForUi = { ...eventForUi, reasoning: reasoningDelta };
          } else {
            // 无推理增量时清空，避免 bridge 误把累计值当 delta。
            eventForUi = { ...eventForUi, reasoning: undefined };
          }
          rawEvents.push(eventForUi);
          if (eventForUi.event === "values") {
            finalState = eventForUi.data;
          }
          await input.onEvent?.(eventForUi);
        });
        break;
      } catch (error) {
        if (attempt === 0 && isActiveRunConflict(error)) {
          threadId = await this.replaceThreadBinding(input, threadId, "active_run_conflict");
          uploads = await this.uploadAttachments(threadId, input.userId, input.attachmentFiles ?? [], input.signal);
          runInput = { ...input, deerFlowUploads: uploads };
          rawEvents.length = 0;
          assistantText = "";
          reasoningText = "";
          finalState = undefined;
          continue;
        }
        throw error;
      }
    }

    if (!finalState) {
      finalState = await this.getThreadState(threadId, input.userId, input.signal).catch(() => undefined);
    }

    const visibleAssistantText = assistantText.trim() || extractAssistantTextFromFinalState(finalState);
    const finalAction = extractFinalAction(visibleAssistantText, finalState);
    const userVisibleAssistantText = stripFinalActionBlock(visibleAssistantText).trim();
    const artifacts = await this.resolveArtifacts(threadId, input.userId, finalAction.artifacts ?? [], input.signal);
    if (artifacts.length) {
      await input.onEvent?.({
        event: "gateway-artifacts",
        data: { artifacts },
        content: `已同步 ${artifacts.filter((artifact) => artifact.status === "fetched").length} 个 DeerFlow 产物。`,
      });
    }

    return {
      threadId,
      assistantText: userVisibleAssistantText || finalAction.message || visibleAssistantText,
      finalAction,
      uploads,
      artifacts,
      rawEvents,
      finalState,
    };
  }

  private async ensureThread(input: DeerFlowRunInput) {
    const existing = await this.prisma.deerFlowThreadBinding.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (existing) {
      assertThreadBindingMatchesInput(existing, input);
      return existing.deerFlowThreadId;
    }

    const thread = await this.createThread({
      aiProductWorkbenchConversationId: input.conversationId,
      aiProductWorkbenchUserId: input.userId,
      source: "ai-product-workbench",
    }, input.signal, input.userId);

    try {
      const created = await this.prisma.deerFlowThreadBinding.create({
        data: {
          conversationId: input.conversationId,
          userId: input.userId,
          deerFlowThreadId: thread.threadId,
          metadata: toInputJson(thread.metadata),
        },
      });
      return created.deerFlowThreadId;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const createdByAnotherTurn = await this.prisma.deerFlowThreadBinding.findUnique({
          where: { conversationId: input.conversationId },
        });
        if (createdByAnotherTurn) {
          assertThreadBindingMatchesInput(createdByAnotherTurn, input);
          return createdByAnotherTurn.deerFlowThreadId;
        }
      }
      throw error;
    }
  }

  private async replaceThreadBinding(input: DeerFlowRunInput, previousThreadId: string, reason: string) {
    const thread = await this.createThread({
      aiProductWorkbenchConversationId: input.conversationId,
      aiProductWorkbenchUserId: input.userId,
      source: "ai-product-workbench",
      replacedDeerFlowThreadId: previousThreadId,
      replacementReason: reason,
    }, input.signal, input.userId);

    try {
      const updated = await this.prisma.deerFlowThreadBinding.update({
        where: { conversationId: input.conversationId },
        data: {
          conversationId: input.conversationId,
          userId: input.userId,
          deerFlowThreadId: thread.threadId,
          metadata: toInputJson(thread.metadata),
        },
      });
      return updated.deerFlowThreadId;
    } catch (error) {
      if (isRecordNotFoundError(error)) {
        const created = await this.prisma.deerFlowThreadBinding.create({
          data: {
            conversationId: input.conversationId,
            userId: input.userId,
            deerFlowThreadId: thread.threadId,
            metadata: toInputJson(thread.metadata),
          },
        });
        return created.deerFlowThreadId;
      }
      throw error;
    }
  }

  private async createThread(
    metadata: Record<string, unknown>,
    signal?: AbortSignal,
    userId?: string,
  ) {
    const response = await this.requestJson<ThreadCreateResponse>(threadCreatePath(), {
      method: "POST",
      body: JSON.stringify({ metadata }),
    }, signal, userId);
    const threadId = response.thread_id ?? response.threadId;
    if (!threadId) {
      throw new Error("DeerFlow thread 创建成功但未返回 thread_id");
    }
    return { threadId, metadata };
  }

  private async streamRun(
    threadId: string,
    input: DeerFlowRunInput,
    onEvent: (event: DeerFlowRuntimeEvent) => Promise<void> | void,
  ) {
    const response = await fetchWithTimeout(langGraphUrl(runStreamPath(threadId)), {
      method: "POST",
      headers: jsonHeaders(input.userId),
      body: JSON.stringify(buildRunRequest(input)),
    }, input.signal);
    if (!response.ok) {
      throw new DeerFlowRunStreamError(response.status, await safeResponseText(response));
    }
    if (!response.body) {
      throw new Error("DeerFlow run stream 未返回响应体");
    }

    await readSse(response.body, async (event) => {
      if (input.signal?.aborted) return;
      await onEvent(normalizeDeerFlowEvent(event.event, event.data));
    }, input.signal);
  }

  private async uploadAttachments(
    threadId: string,
    userId: string,
    attachments: RuntimeAttachmentFile[],
    signal?: AbortSignal,
  ) {
    if (!attachments.length) return [];
    if (!readBooleanEnv("DEERFLOW_UPLOADS_ENABLED", true)) return [];

    const formData = new FormData();
    for (const attachment of attachments) {
      const buffer = await readFile(attachment.storagePath);
      formData.append(
        "files",
        new Blob([new Uint8Array(buffer)], { type: attachment.mimeType || "application/octet-stream" }),
        attachment.fileName,
      );
    }

    const response = await fetchWithTimeout(gatewayUrl(uploadPath(threadId)), {
      method: "POST",
      headers: deerFlowIdentityHeaders(userId),
      body: formData,
    }, signal);
    if (!response.ok) {
      throw new Error(`DeerFlow upload 请求失败：${response.status} ${await safeResponseText(response)}`);
    }

    const payload = await response.json() as UploadFilesResponse;
    const files = Array.isArray(payload.files) ? payload.files : [];
    if (!payload.success && !files.length) {
      throw new Error(`DeerFlow upload 未返回文件信息：${payload.message ?? "unknown error"}`);
    }
    if (files.length < attachments.length) {
      throw new Error(`DeerFlow upload 返回文件数量不完整：${files.length}/${attachments.length}`);
    }

    return attachments.map((attachment, index) => ({
      fileId: attachment.fileId,
      fileName: attachment.fileName,
      fileType: attachment.fileType,
      size: attachment.size,
      deerFlowFile: normalizeUploadedFile(files[index]),
    }));
  }

  private async resolveArtifacts(
    threadId: string,
    userId: string,
    artifacts: DeerFlowArtifactReference[],
    signal?: AbortSignal,
  ) {
    const limit = readNumberEnv("DEERFLOW_ARTIFACT_MAX_INLINE_BYTES", 2_000_000);
    const resolved: DeerFlowResolvedArtifact[] = [];
    for (const artifact of artifacts) {
      const artifactPath = normalizeArtifactPath(artifact.path ?? artifact.artifactUrl);
      if (!artifactPath) continue;
      const artifactUrl = artifactUrlFor(threadId, artifactPath);
      try {
        const response = await fetchWithTimeout(gatewayUrl(artifactPathFor(threadId, artifactPath)), {
          method: "GET",
          headers: deerFlowIdentityHeaders(userId),
        }, signal);
        if (!response.ok) {
          resolved.push({
            ...artifact,
            path: artifactPath,
            artifactUrl,
            status: "failed",
            errorMessage: `${response.status} ${await safeResponseText(response)}`,
          });
          continue;
        }
        const contentType = response.headers.get("content-type") ?? artifact.contentType;
        const contentLength = readContentLength(response);
        if (!isInlineTextArtifact(artifactPath, contentType) || (contentLength !== undefined && contentLength > limit)) {
          await response.body?.cancel().catch(() => undefined);
          resolved.push({
            ...artifact,
            path: artifactPath,
            artifactUrl,
            contentType,
            status: "skipped",
            size: contentLength,
          });
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        resolved.push({
          ...artifact,
          path: artifactPath,
          artifactUrl,
          contentType,
          status: buffer.byteLength <= limit ? "fetched" : "skipped",
          size: buffer.byteLength,
          text: buffer.byteLength <= limit ? buffer.toString("utf8") : undefined,
        });
      } catch (error) {
        resolved.push({
          ...artifact,
          path: artifactPath,
          artifactUrl,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "artifact fetch failed",
        });
      }
    }
    return resolved;
  }

  private async getThreadState(threadId: string, userId: string, signal?: AbortSignal) {
    return this.requestJson(threadStatePath(threadId), { method: "GET" }, signal, userId);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    userId?: string,
  ): Promise<T> {
    const response = await fetchWithTimeout(langGraphUrl(path), {
      ...init,
      headers: {
        ...jsonHeaders(userId),
        ...(init.headers ?? {}),
      },
    }, signal);
    if (!response.ok) {
      throw new Error(`DeerFlow 请求失败：${response.status} ${await safeResponseText(response)}`);
    }
    return await response.json() as T;
  }
}

function buildRunRequest(input: DeerFlowRunInput) {
  return {
    assistant_id: process.env.DEERFLOW_ASSISTANT_ID ?? "lead_agent",
    input: {
      messages: [
        {
          role: "user",
          content: buildUserPrompt(input),
        },
      ],
    },
    stream_mode: readStreamMode(),
    config: {
      configurable: {
        is_plan_mode: readBooleanEnv("DEERFLOW_PLAN_MODE", true),
        thinking_enabled: readBooleanEnv("DEERFLOW_THINKING_ENABLED", true),
        subagent_enabled: readBooleanEnv("DEERFLOW_SUBAGENT_ENABLED", true),
        max_concurrent_subagents: readNumberEnv("DEERFLOW_MAX_CONCURRENT_SUBAGENTS", 3),
        model_name:
          input.selectedModelName ||
          process.env.DEERFLOW_MODEL_NAME ||
          process.env.DEFAULT_MODEL_NAME ||
          undefined,
        agent_name: process.env.DEERFLOW_AGENT_NAME || undefined,
      },
    },
  };
}

function assertThreadBindingMatchesInput(
  binding: {
    conversationId: string;
    userId: string;
    deerFlowThreadId: string;
  },
  input: DeerFlowRunInput,
) {
  if (
    binding.conversationId === input.conversationId &&
    binding.conversationId === input.conversationId &&
    binding.userId === input.userId
  ) {
    return;
  }

  throw new ConflictException(
    [
      "DeerFlow thread 绑定与当前会话不一致，已拒绝复用旧上下文。",
      `conversationId=${input.conversationId}`,
      `conversationId=${input.conversationId}`,
      `userId=${input.userId}`,
      `boundThreadId=${binding.deerFlowThreadId}`,
    ].join(" "),
  );
}

function buildUserPrompt(input: DeerFlowRunInput) {
  const knowledgeContext = input.knowledgeContext ?? [];
  const context = {
    runtimeContract: "ai-product-workbench.deerflow-runtime.v1",
    runId: input.runId,
    conversationId: input.conversationId,
    previewMode: input.previewMode,
    selectedRegion: input.selectedRegion,
    attachments: input.attachments ?? [],
    deerFlowUploads: input.deerFlowUploads ?? [],
    resumeReason: input.resumeReason,
    conversationDesignState: input.conversationDesignState,
    knowledgeContext,
    externalResearchContext: input.externalResearchContext ?? {
      status: "skipped_not_needed",
      fetchedAt: new Date(0).toISOString(),
      searchQueries: [],
      refs: [],
      failures: [],
      privacyBoundary: [],
    },
    knowledgeWorkflowPolicy: buildKnowledgeWorkflowPolicy(input, knowledgeContext),
    finalActionContract: {
      instruction: "At the end, include one fenced block named ai_product_workbench_final_action with JSON.",
      schema: {
        type: "answer | review_prd | review_prototype | ask_clarification | download_export",
        message: "user-facing Chinese summary",
        intent: "optional intent label",
        requirementMode: "optional: historical_extension | new_capability | brand_new_system | one_sentence_completion",
        knowledgeRefsUsed: "optional array of knowledge paths or titles used for reasoning",
        externalRefsUsed:
          "optional array of public external references used after local knowledge was applied; use title + URL when available; leave [] when search tools are unavailable or not needed",
        externalResearchStatus:
          "optional: completed | skipped_not_needed | skipped_tools_unavailable | failed_non_blocking",
        enrichmentNotes:
          "optional user-safe notes that summarize what was filled by model inference and what was filled by external search/fetch",
        assumptions: "optional inferred business facts, especially for one-sentence requirements",
        consistencyStrategy: "optional PRD/prototype consistency strategy",
        prdDocumentDraft:
          "required for review_prd when possible: full PRD document, not a summary; shape { title, sections: [{ id, title, type, level, order, content, blocks?, sourcePaths? }], validationNotes? }. Use the standard Chinese requirement-document section order: 1 引言 / 1.1 项目背景 / 1.2 文档范围 / 1.3 使用场景（必填） / 2 业务需求 / 2.1 页面链接 / core business sections / 本需求涉及新增/修改的接口 / 验收标准 / 3 业务降级方案（必填） / 4 需求安全基线要求（必填）. blocks may include paragraph, bullet_list, table, quote, warning, info, diagram, image, prototype_snapshot, asset_reference.",
        artifacts: [
          {
            kind: "optional artifact kind, for example prototype_html or prd_markdown",
            title: "optional user-facing artifact title",
            path: "optional virtual artifact path, for example mnt/user-data/outputs/index.html",
            artifactUrl: "optional Gateway artifact URL",
            contentType: "optional MIME type",
          },
        ],
      },
      constraints: [
        "Do not mutate the Workbench database directly.",
        "Classify conversation turns as historical_extension, new_capability, brand_new_system, or one_sentence_completion before drafting.",
        "historical_extension means adding to or changing an existing conversation/page: preserve the existing PRD/prototype information architecture, layout, field grouping, state flow, interaction style, tab-bar style, and component conventions unless the user explicitly asks for redesign.",
        "new_capability means a new capability inside an existing conversation: reuse product_architecture and the platform page framework, then design a clearer local information architecture for the new capability.",
        "brand_new_system means a completely new system/page: if a tab bar is present in the target experience, follow the retrieved ui_style_guide tab style while allowing the rest of the page style to be redesigned; if no tab bar is present, you may redesign the page style from scratch.",
        "Use product_architecture/page_inventory/ui_style_guide/prototype_asset_ref knowledge items when available to decide reuse vs redesign; cite them in knowledgeRefsUsed.",
        "Knowledge-first workflow: use knowledgeContext before general model knowledge. After the local knowledge baseline is applied, you may use model reasoning and available web search/fetch tools to fill missing current or general details, but local product rules win over web results.",
        "When knowledgeContext is non-empty and the user asks for a PRD/prototype/方案, do not stop at copying local knowledge: first infer ordinary missing product details with the model, then use available web search/fetch for public, generic, current, or industry-practice details when helpful. If search/fetch tools are unavailable, set externalResearchStatus=skipped_tools_unavailable and continue with model inference.",
        "If externalResearchContext.refs is non-empty, use those refs as already fetched public evidence and cite them in externalRefsUsed/enrichmentNotes; do not repeat search unless there is a clear missing public fact.",
        "Never send private files, raw source assets, internal paths, conversation IDs, user IDs, credentials, or complete user documents to web search. Search only generic product/domain terms derived from the request, such as 签到积分活动 会员运营 最佳实践.",
        "If external information is used, cite it only in externalRefsUsed/enrichmentNotes and relevant PRD source notes; do not paste long web excerpts into the chat or PRD.",
        "If knowledgeContext is empty, do not claim the PRD/prototype is knowledge-base driven. Return a concise ask_clarification or answer that says the knowledge base missed and names the missing knowledge area.",
        "For one_sentence_completion, infer ordinary missing details from product_architecture knowledge, business-domain knowledge, and historical cases; ask clarification only for blocking or high-risk facts.",
        "For review_prd, return the complete PRD body in prdDocumentDraft.sections or a complete prd_markdown artifact. Never return only a change summary as the PRD document.",
        "For activity-configuration PRDs, include visual evidence blocks when knowledgeContext provides them: at least one business flow diagram, one configuration architecture diagram, and prototype_snapshot/image blocks for key Axure pages. Use Mermaid for diagram blocks and local visualAssets paths for prototype_snapshot/image blocks.",
        "If no suitable prototype snapshot, flow, architecture, or field-rule knowledge is available, do not invent visuals. Add a validationNotes item and an info/warning block that names the missing asset and the required follow-up.",
        "For PRD/需求文档/需求说明书 generation, follow the requirement-document template from PRD标准结构 exactly: cover title should be <工单名称>需求说明书; body sections must include 1 引言(1.1 项目背景, 1.2 文档范围, 1.3 使用场景必填), 2 业务需求(2.1 页面链接, core rules/features, flow/state/page requirements, 2.4 接口能力/联动口径, 验收标准), 3 业务降级方案（必填）, 4 需求安全基线要求（必填）. Section 2.4 may describe required interface capabilities, upstream/downstream linkage, trigger timing, data direction, and business error handling, but must not include real API URLs, secrets, credentials, or backend implementation specifications. Do not use a freeform lightweight PRD unless the user explicitly asks for it.",
        "For PRD tables, use explicit table blocks or markdown tables for version history, channel/使用场景, field/rule tables, acceptance tables, and the safety baseline self-check. Do not replace tables with prose.",
        "For PRD section content, every heading must have concrete content. If an exact route, author, participant, or date is unknown, write 待确认 or 以实际上线地址/联调结果为准, while still describing expected behavior from the business perspective.",
        "For PRD safety/degradation content, do not leave the section empty: write 不涉及 only when truly irrelevant; otherwise provide concrete fallback behavior and safety baseline self-check values using only 是, 否, or 不涉及.",
        "When updating an existing PRD, merge the requested change into the currentPrdDocument and preserve unaffected sections, title hierarchy, tables, state flows, acceptance criteria, and implementation details.",
        "If coding or prototype execution is needed, use DeerFlow coding/prototype execution capability inside the graph.",
        "Use deerFlowUploads virtualPath or markdownVirtualPath when reading uploaded files.",
        "When knowledgeContext entries contain visualAssets, cite the asset path in blocks as { type: 'prototype_snapshot' | 'image', content: 'caption', assetPath, title?, sourcePaths? }.",
        "When you generate files, include their output artifact paths in finalActionContract.artifacts.",
        "For review_prototype, the prototype_html artifact must satisfy prototypeHtmlContract exactly. Never output a bare HTML fragment, unstyled semantic HTML, markdown, an image mock, or content that relies on browser default typography/table/button styles.",
        "Return final action instead of asking NestJS to decide the workflow.",
        "For PRD/document generation, do not stream the full PRD body as ordinary chat prose. Put the complete body in prdDocumentDraft.sections or a prd_markdown artifact, then use a concise finalAction.message; AI Product Workbench will open the canvas from the saved PRD.",
        "Keep non-document progress notes, clarifying comments, and tool/coding updates outside the document body so they remain suitable for the chat transcript.",
        "Keep the user-visible chat clean: never paste tool outputs, skill files, todo lists, JSON context, or execution logs as ordinary assistant text.",
      ],
    },
    prototypeHtmlContract: {
      previewEnvironment:
        "AI Product Workbench renders saved prototype_html through a preview URL in a sandboxed iframe. The prototype must be a complete standalone HTML document that does not rely on parent app CSS, fonts, layout, or resets.",
      requiredArtifact:
        "For review_prototype, create exactly one text/html artifact at mnt/user-data/outputs/index.html and reference it in finalActionContract.artifacts with kind=prototype_html and contentType=text/html.",
      requiredDocumentShape: [
        "<!doctype html>",
        '<html lang="zh-CN">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>...</title>",
        "<style>...complete CSS reset, layout, typography, tables, forms, buttons, tabs, cards, states...</style>",
        "</head>",
        "<body>...prototype screens...</body>",
        "</html>",
      ],
      stylingRequirements: [
        "All visual styling must be inside the same HTML file, preferably in one <style> block in <head>; do not depend on Tailwind, parent CSS, remote CSS, local assets, web fonts, or CDN resources.",
        "Start with a small CSS reset: box-sizing:border-box; html/body margin:0; system sans-serif font; stable background; readable color; explicit line-height.",
        "Use app-like operational UI, not a document outline: constrained page shell, header/navigation, tabs/filter chips, tables/lists/forms/cards/status badges/actions, empty/error states, and realistic spacing.",
        "Set explicit font sizes for h1/h2/h3/body/table/button/input so the iframe never falls back to oversized Times-style browser defaults.",
        "Style tables with width:100%, border-collapse, padded th/td, header background, and responsive overflow handling.",
        "Use Chinese labels and realistic sample data from the PRD/design state; keep columns and controls aligned at desktop width while remaining usable in the small inline preview.",
        "If interaction cannot use scripts because stored prototypes are sanitized, present the key states as visible static sections or CSS-only variants.",
      ],
      forbiddenOutput: [
        "裸 <h1>/<table>/<button> 片段",
        "Created By Deerflow default link as the primary first element",
        "browser-default Times/serif typography",
        "external stylesheet/script dependencies",
        "markdown tables or fenced code instead of an HTML file",
      ],
    },
  };

  return [
    input.message,
    "",
    "Context from AI Product Workbench:",
    "```json",
    JSON.stringify(context),
    "```",
  ].join("\n");
}

function buildKnowledgeWorkflowPolicy(
  input: DeerFlowRunInput,
  knowledgeContext: DeerFlowKnowledgeReference[],
) {
  const hasKnowledgeHit = knowledgeContext.length > 0;
  return {
    localKnowledgeStatus: hasKnowledgeHit ? "hit" : "miss",
    order: [
      "1. Local knowledge baseline: apply knowledgeContext first and cite knowledgeRefsUsed.",
      "2. Model enrichment: infer ordinary missing product details, defaults, states, and acceptance criteria; write them into assumptions/enrichmentNotes.",
      "3. Web enrichment: after local knowledge is applied, use available search/fetch tools for public/current/general practice details when helpful; write externalRefsUsed/externalResearchStatus.",
      "4. Conflict rule: local product knowledge and user-provided facts override model guesses and web results.",
    ],
    emptyKnowledgeBehavior:
      "如果 knowledgeContext 为空，先说明知识库未命中并给出最小可继续方案；不要假装已经引用知识库。",
    userVisibleNoisePolicy:
      "不要把技能文件内容、工具输入输出、todo、read_file/search/fetch 日志、隐藏推理或运行调试信息写入聊天正文或 PRD 正文。",
    modelEnrichmentChecklist: [
      "补齐目标用户、使用场景、页面/状态、异常/降级、接口联动口径、验收标准。",
      "对一两句话需求做合理业务推断，但把积分值、预算、活动周期、目标人群等不确定项写入 assumptions 或 待确认。",
      "PRD 与原型必须共享同一组核心规则、状态和页面结构，避免文档与原型各写各的。",
    ],
    externalSearchPolicy: {
      enabledAfterKnowledgeHit: hasKnowledgeHit,
      mustAttemptWhen:
        "knowledgeContext 非空，且用户要求 PRD/原型/方案；如果 DeerFlow 当前没有 search/fetch 工具，则继续生成并标记 externalResearchStatus=skipped_tools_unavailable。",
      searchQueries: buildExternalSearchQueries(input.message, knowledgeContext),
      privacyGuardrails: [
        "只搜索通用领域词，不搜索内部文件名、知识库路径、会话 ID、用户 ID、附件原文、真实接口、密钥或客户资料。",
        "外部资料只能补充行业惯例、现行概念、体验参考和风险提醒，不能覆盖本地知识库强规则。",
        "不要把网页长段落原样粘进聊天正文、PRD 正文或原型。",
      ],
      outputRequirements: [
        "externalResearchStatus 必须说明 completed/skipped_not_needed/skipped_tools_unavailable/failed_non_blocking。",
        "externalRefsUsed 只列实际用过的公开来源；没有用就返回空数组。",
        "enrichmentNotes 用用户能看懂的话说明：哪些来自知识库、哪些是模型合理补齐、哪些来自联网补充。",
      ],
    },
  };
}

function buildExternalSearchQueries(message: string, knowledgeContext: DeerFlowKnowledgeReference[]) {
  const compact = message.replace(/\s+/g, "");
  const queries: string[] = [];

  if (/(签到|打卡|积分|奖励|奖品|权益|活动)/.test(compact)) {
    queries.push("签到积分活动 会员运营 最佳实践");
    queries.push("积分权益 发放 幂等 风控 资损");
    queries.push("营销活动 连续签到 奖励机制 用户体验");
  }
  if (/(需求文档|需求说明书|prd|PRD)/.test(message)) {
    queries.push("产品需求文档 验收标准 风险 降级 规范");
  }
  if (/(原型|prototype|页面|界面|交互)/i.test(message)) {
    queries.push("后台配置 前台活动页 原型 交互状态 设计模式");
  }

  for (const item of knowledgeContext.slice(0, 3)) {
    const title = item.title.replace(/[^\p{Script=Han}a-z0-9 ]/giu, " ").replace(/\s+/g, " ").trim();
    if (title) queries.push(`${title} 行业实践 风险控制`);
  }

  return [...new Set(queries)].slice(0, 6);
}

function normalizeDeerFlowEvent(event: string, data: unknown): DeerFlowRuntimeEvent {
  const payload = primaryPayload(data);
  const record = asRecord(payload);
  // 推理内容独立提取（reasoning_content / thinking 项 / <think>），不计入正文 content/chunk。
  const reasoning = extractReasoning(record);
  const content = shouldExposeEventContent(event, record) ? toContentText(payload) : undefined;
  const toolCalls = extractToolCalls(record) ?? extractToolCalls(asRecord(data));
  const messageRole = detectMessageRole(record);
  const isToolMessage = messageRole === "tool";
  const toolCallId = isToolMessage ? toOptionalString(record?.tool_call_id) ?? toOptionalString(record?.toolCallId) : undefined;
  const toolResult = isToolMessage ? toContentText(payload) : undefined;
  const nodeId = toOptionalString(asRecord(data)?.node) ?? toOptionalString(asRecord(data)?.node_id);
  return {
    event,
    data,
    content,
    toolName: extractToolName(record) ?? extractToolName(asRecord(data)),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolCallId,
    toolResult,
    messageRole,
    // assistant 增量文本：用于前端逐字流式渲染（Phase 2）。
    chunk: messageRole === "assistant" ? content : undefined,
    reasoning,
    nodeId,
    nodeName: nodeId ?? undefined,
  };
}

/**
 * 从一条消息记录里提取推理文本（累计值，尚未 delta 化）。
 * 覆盖三类来源：
 *  - OpenAI o 系列 / DeepSeek：additional_kwargs.reasoning_content / response_metadata.reasoning_content
 *  - Anthropic via LangGraph：content 数组中 type === "thinking" 项的 thinking/text 字段
 *  - 通用 <think>…</think> 包裹
 * 提取后正文 content 由 toContentText 另算（thinking 项不带 text 字段，故通常不混入正文）。
 */
function extractReasoning(record: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  const additional = asRecord(record.additional_kwargs);
  const fromAdditional = toOptionalString(additional?.reasoning_content) ?? toOptionalString(additional?.reasoning);
  if (fromAdditional) return fromAdditional;
  const responseMetadata = asRecord(record.response_metadata);
  const fromResponse = toOptionalString(responseMetadata?.reasoning_content);
  if (fromResponse) return fromResponse;

  const content = record.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const itemRecord = asRecord(item);
      const type = toOptionalString(itemRecord?.type)?.toLowerCase();
      if (type !== "thinking" && type !== "reasoning") continue;
      const text =
        toOptionalString(itemRecord?.thinking) ??
        toOptionalString(itemRecord?.text) ??
        toOptionalString(itemRecord?.reasoning_text);
      if (text) parts.push(text);
    }
    if (parts.length) return parts.join("\n");
  }

  const whole = toOptionalString(record.content);
  if (whole) {
    const match = whole.match(/<think>([\s\S]*?)<\/think>/i);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function detectMessageRole(record: Record<string, unknown> | null): DeerFlowRuntimeEvent["messageRole"] {
  if (!record) return "unknown";
  const role = toOptionalString(record.role)?.toLowerCase();
  const type = toOptionalString(record.type)?.toLowerCase();
  if (role === "assistant" || role === "ai" || type === "ai" || type === "assistant" || type === "aimessage" || type === "aimessagechunk") {
    return "assistant";
  }
  if (role === "tool" || type === "tool" || type === "toolmessage") return "tool";
  if (role === "system" || type === "system" || type === "systemmessage") return "system";
  if (role === "human" || role === "user" || type === "human" || type === "humanmessage") return "human";
  return "unknown";
}

function extractToolCalls(record: Record<string, unknown> | null): DeerFlowToolCall[] {
  if (!record) return [];
  const raw = record.tool_calls ?? asRecord(record.additional_kwargs)?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: DeerFlowToolCall[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const fn = asRecord(entry?.function);
    const id = toOptionalString(entry?.id) ?? toOptionalString(fn?.id) ?? `tool_call_${Math.random().toString(36).slice(2)}`;
    const name = toOptionalString(fn?.name) ?? toOptionalString(entry?.name);
    if (!name) continue;
    const argsRaw = fn?.arguments ?? entry?.args ?? entry?.input;
    let args: unknown = argsRaw;
    if (typeof argsRaw === "string") {
      try { args = JSON.parse(argsRaw); } catch { args = argsRaw; }
    }
    calls.push({ id, name, args });
  }
  return calls;
}

function isAssistantTextEvent(event: DeerFlowRuntimeEvent) {
  return (event.event === "messages" || event.event === "messages-tuple") && Boolean(event.content);
}

function assistantTextDelta(previous: string, incoming: string) {
  if (!incoming || incoming === previous) return "";
  if (incoming.startsWith(previous)) return incoming.slice(previous.length);

  const overlap = longestSuffixPrefixOverlap(previous, incoming);
  if (overlap < 16) return incoming;
  return overlap > 0 ? incoming.slice(overlap) : incoming;
}

function longestSuffixPrefixOverlap(previous: string, incoming: string) {
  const maxLength = Math.min(previous.length, incoming.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (previous.endsWith(incoming.slice(0, length))) return length;
  }
  return 0;
}

function shouldExposeEventContent(event: string, record: Record<string, unknown> | null) {
  if (event !== "messages" && event !== "messages-tuple") return false;
  if (!record) return false;
  if (isHiddenRuntimeMessage(record)) return false;
  if (isAssistantMessageRecord(record)) return true;
  return event === "messages-tuple" && !record.type && !record.role;
}

function isAssistantMessageRecord(record: Record<string, unknown> | null) {
  if (!record) return false;
  const role = toOptionalString(record.role)?.toLowerCase();
  if (role === "assistant" || role === "ai") return true;
  const type = toOptionalString(record.type)?.toLowerCase();
  return type === "ai" || type === "assistant" || type === "aimessage" || type === "aimessagechunk";
}

function isHiddenRuntimeMessage(record: Record<string, unknown>) {
  if (asRecord(record.additional_kwargs)?.hide_from_ui === true) return true;
  const role = toOptionalString(record.role)?.toLowerCase();
  const type = toOptionalString(record.type)?.toLowerCase();
  const name = toOptionalString(record.name)?.toLowerCase();
  const content = toContentText(record)?.trim().toLowerCase();
  return [role, type, name].some((value) =>
    Boolean(value && (
      value === "human" ||
      value === "humanmessage" ||
      value === "user" ||
      value === "system" ||
      value === "systemmessage" ||
      value === "memory" ||
      value.includes("memory")
    )),
  ) || Boolean(content && (content.startsWith("<memory") || content.includes("<memory>")));
}

function extractAssistantTextFromFinalState(finalState: unknown) {
  const messages = asRecord(finalState)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = asRecord(messages[index]);
    if (!isAssistantMessageRecord(record)) continue;
    const content = toContentText(record);
    if (content) return content;
  }
  return "";
}

function extractToolName(record: Record<string, unknown> | null) {
  const toolCalls = record?.tool_calls ?? asRecord(record?.additional_kwargs)?.tool_calls;
  if (!Array.isArray(toolCalls)) return undefined;
  const first = asRecord(toolCalls[0]);
  const fn = asRecord(first?.function);
  return toOptionalString(fn?.name) ?? toOptionalString(first?.name);
}

function toContentText(data: unknown) {
  const record = asRecord(data);
  const content = record?.content;
  if (typeof content === "string") return stripInlineReasoning(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return stripInlineReasoning(item);
        const itemRecord = asRecord(item);
        if (isReasoningContentPart(itemRecord)) return "";
        const text = toOptionalString(itemRecord?.text) ?? toOptionalString(itemRecord?.content) ?? "";
        return stripInlineReasoning(text);
      })
      .filter(Boolean)
      .join("");
  }
  return undefined;
}

function isReasoningContentPart(record: Record<string, unknown> | null) {
  const type = toOptionalString(record?.type)?.toLowerCase();
  return type === "thinking" || type === "reasoning";
}

function stripInlineReasoning(value: string) {
  return value.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function extractFinalAction(assistantText: string, finalState: unknown): DeerFlowFinalAction {
  const block = assistantText.match(/```ai_product_workbench_final_action\s*([\s\S]*?)```/i)?.[1];
  const parsed = block ? parseJsonObject(block) : null;
  const message = toOptionalString(parsed?.message) || stripFinalActionBlock(assistantText).trim() || "DeerFlow 本轮已完成。";
  const type = normalizeFinalActionType(parsed?.type);
  return {
    type,
    message,
    intent: toOptionalString(parsed?.intent),
    requirementMode: normalizeRequirementMode(parsed?.requirementMode),
    knowledgeRefsUsed: toStringList(parsed?.knowledgeRefsUsed),
    externalRefsUsed: toStringList(parsed?.externalRefsUsed),
    enrichmentNotes: toStringList(parsed?.enrichmentNotes),
    externalResearchStatus: toOptionalString(parsed?.externalResearchStatus),
    artifacts: extractArtifactReferences(parsed?.artifacts),
    raw: parsed ?? { finalState },
    // parsed 为 true 仅当成功解析出 JSON 块；否则为静默降级（pipe-6：不再无声失败）。
    parsed: Boolean(parsed),
  };
}

function extractArtifactReferences(value: unknown): DeerFlowArtifactReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const artifacts = value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const artifact: DeerFlowArtifactReference = {
        kind: toOptionalString(record.kind) ?? toOptionalString(record.type),
        title: toOptionalString(record.title) ?? toOptionalString(record.name),
        path: toOptionalString(record.path) ?? toOptionalString(record.virtual_path) ?? toOptionalString(record.virtualPath),
        artifactUrl:
          toOptionalString(record.artifactUrl) ??
          toOptionalString(record.artifact_url) ??
          toOptionalString(record.url),
        contentType: toOptionalString(record.contentType) ?? toOptionalString(record.content_type),
        metadata: record.metadata,
      };
      return artifact.path || artifact.artifactUrl ? artifact : null;
    })
    .filter((item): item is DeerFlowArtifactReference => Boolean(item));
  return artifacts.length ? artifacts : undefined;
}

function normalizeRequirementMode(value: unknown): DeerFlowFinalAction["requirementMode"] {
  if (
    value === "historical_extension" ||
    value === "new_capability" ||
    value === "brand_new_system" ||
    value === "one_sentence_completion"
  ) {
    return value;
  }
  return undefined;
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => toOptionalString(item)).filter((item): item is string => Boolean(item));
  return items.length ? items : undefined;
}

function normalizeFinalActionType(value: unknown): DeerFlowFinalAction["type"] {
  if (
    value === "review_prd" ||
    value === "review_prototype" ||
    value === "ask_clarification" ||
    value === "download_export"
  ) {
    return value;
  }
  return "answer";
}

function stripFinalActionBlock(value: string) {
  return value.replace(/```ai_product_workbench_final_action\s*[\s\S]*?```/gi, "").trim();
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value.trim());
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: { event: string; data: unknown }) => Promise<void> | void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = readNumberEnv("DEERFLOW_IDLE_TIMEOUT_MS", 120_000);
  let buffer = "";

  if (signal?.aborted) {
    await reader.cancel("DEERFLOW_STREAM_ABORTED").catch(() => undefined);
    throw new Error("DEERFLOW_STREAM_ABORTED");
  }

  try {
    while (true) {
      const { value, done } = await readStreamChunkWithIdleTimeout(reader, idleTimeoutMs, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const event = parseSseChunk(part);
        if (event) await onEvent(event);
      }
    }
  } finally {
    try {
      (reader as { releaseLock?: () => void }).releaseLock?.();
    } catch {
      // 清理 reader 不能掩盖上游流错误。
    }
  }

  buffer += decoder.decode();
  const event = parseSseChunk(buffer);
  if (event) await onEvent(event);
}

async function readStreamChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    await reader.cancel("DEERFLOW_STREAM_ABORTED").catch(() => undefined);
    throw new Error("DEERFLOW_STREAM_ABORTED");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const promises: Array<Promise<ReadableStreamReadResult<Uint8Array>> | Promise<never>> = [reader.read()];
    if (idleTimeoutMs > 0) {
      promises.push(new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void reader.cancel("DEERFLOW_STREAM_IDLE_TIMEOUT").catch(() => undefined);
          reject(new Error(`DEERFLOW_STREAM_IDLE_TIMEOUT: no stream chunk received within ${idleTimeoutMs}ms`));
        }, idleTimeoutMs);
      }));
    }
    if (signal) {
      promises.push(new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          void reader.cancel("DEERFLOW_STREAM_ABORTED").catch(() => undefined);
          reject(new Error("DEERFLOW_STREAM_ABORTED"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }));
    }
    return await Promise.race(promises);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function parseSseChunk(chunk: string) {
  if (!chunk.trim()) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const rawData = dataLines.join("\n");
  return {
    event,
    data: parseSseData(rawData),
  };
}

function parseSseData(value: string) {
  if (!value || value === "[DONE]") return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeUploadedFile(value: unknown): DeerFlowUploadedFile["deerFlowFile"] {
  const record = asRecord(value);
  if (!record) return {};
  return {
    filename: toOptionalString(record.filename),
    size: toOptionalString(record.size),
    path: toOptionalString(record.path),
    virtualPath: toOptionalString(record.virtual_path) ?? toOptionalString(record.virtualPath),
    artifactUrl: toOptionalString(record.artifact_url) ?? toOptionalString(record.artifactUrl),
    markdownFile: toOptionalString(record.markdown_file) ?? toOptionalString(record.markdownFile),
    markdownPath: toOptionalString(record.markdown_path) ?? toOptionalString(record.markdownPath),
    markdownVirtualPath:
      toOptionalString(record.markdown_virtual_path) ??
      toOptionalString(record.markdownVirtualPath),
    markdownArtifactUrl:
      toOptionalString(record.markdown_artifact_url) ??
      toOptionalString(record.markdownArtifactUrl),
  };
}

function normalizeArtifactPath(value: string | undefined) {
  if (!value) return undefined;
  const withoutQuery = value.split("?")[0];
  const marker = "/artifacts/";
  const markerIndex = withoutQuery.indexOf(marker);
  const rawPath = markerIndex >= 0 ? withoutQuery.slice(markerIndex + marker.length) : withoutQuery;
  return rawPath.replace(/^\/+/, "");
}

function primaryPayload(data: unknown) {
  if (Array.isArray(data)) return data[0] ?? data;
  return data;
}

function readStreamMode() {
  const modes = (process.env.DEERFLOW_STREAM_MODE ?? "messages,values")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (modes.length <= 1) return modes[0] ?? "messages";
  return modes;
}

function langGraphUrl(path: string) {
  return joinUrl(process.env.DEERFLOW_LANGGRAPH_URL ?? "http://localhost:8001/api", path);
}

function gatewayUrl(path: string) {
  return joinUrl(process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001", path);
}

function threadCreatePath() {
  return process.env.DEERFLOW_THREAD_CREATE_PATH ?? "/threads";
}

function threadStatePath(threadId: string) {
  const template = process.env.DEERFLOW_THREAD_STATE_PATH ?? "/threads/{threadId}/state";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function runStreamPath(threadId: string) {
  const template = process.env.DEERFLOW_RUN_STREAM_PATH ?? "/threads/{threadId}/runs/stream";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function uploadPath(threadId: string) {
  const template = process.env.DEERFLOW_UPLOAD_PATH ?? "/api/threads/{threadId}/uploads";
  return template.replace("{threadId}", encodeURIComponent(threadId));
}

function artifactPathFor(threadId: string, artifactPath: string) {
  const template = process.env.DEERFLOW_ARTIFACT_PATH ?? "/api/threads/{threadId}/artifacts/{path}";
  return template
    .replace("{threadId}", encodeURIComponent(threadId))
    .replace("{path}", encodeArtifactPath(artifactPath));
}

function artifactUrlFor(threadId: string, artifactPath: string) {
  return gatewayUrl(artifactPathFor(threadId, artifactPath));
}

function encodeArtifactPath(artifactPath: string) {
  return artifactPath
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isInlineTextArtifact(artifactPath: string, contentType: string | undefined) {
  if (contentType?.startsWith("text/")) return true;
  if (contentType?.includes("json") || contentType?.includes("xml")) return true;
  return /\.(html?|md|txt|json|csv|css|js|ts|tsx|jsx|xml|svg)$/i.test(artifactPath);
}

function readContentLength(response: Response) {
  const value = response.headers.get("content-length");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function jsonHeaders(userId?: string) {
  return {
    ...deerFlowIdentityHeaders(userId),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function deerFlowIdentityHeaders(userId?: string) {
  const headers: Record<string, string> = {};
  if (userId) {
    headers["X-DeerFlow-Owner-User-Id"] = userId;
  }
  const internalToken =
    process.env.DEER_FLOW_INTERNAL_AUTH_TOKEN ??
    process.env.DEERFLOW_INTERNAL_AUTH_TOKEN;
  if (internalToken) {
    headers["X-DeerFlow-Internal-Token"] = internalToken;
  }
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal) {
  const timeoutMs = readNumberEnv("DEERFLOW_TIMEOUT_MS", 600_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

async function safeResponseText(response: Response) {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 800);
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isRecordNotFoundError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}

function isActiveRunConflict(error: unknown) {
  if (error instanceof DeerFlowRunStreamError) {
    return error.status === 409 && /active run/i.test(error.responseText);
  }
  if (!(error instanceof Error)) return false;
  return /409/.test(error.message) && /active run/i.test(error.message);
}

class DeerFlowRunStreamError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`DeerFlow run stream 请求失败：${status} ${responseText}`);
  }
}

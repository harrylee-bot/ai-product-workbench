import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";

export type DeerFlowRuntimeEvent = {
  event: string;
  data: unknown;
  content?: string;
  toolName?: string;
};

export type DeerFlowFinalAction = {
  type: "answer" | "review_prd" | "review_prototype" | "ask_clarification" | "download_export";
  message: string;
  intent?: string;
  raw?: unknown;
};

export type DeerFlowTurnResult = {
  threadId: string;
  assistantText: string;
  finalAction: DeerFlowFinalAction;
  rawEvents: DeerFlowRuntimeEvent[];
  finalState?: unknown;
};

type DeerFlowRunInput = {
  projectId: string;
  conversationId: string;
  userId: string;
  message: string;
  runId: string;
  attachments?: unknown[];
  selectedRegion?: unknown;
  previewMode?: string;
  resumeReason?: string;
  productDesignState?: unknown;
  onEvent?: (event: DeerFlowRuntimeEvent) => Promise<void> | void;
};

type ThreadCreateResponse = {
  thread_id?: string;
  threadId?: string;
};

@Injectable()
export class DeerFlowRuntimeService {
  constructor(private readonly prisma: PrismaService) {}

  isEnabled() {
    return readBooleanEnv("DEERFLOW_ENABLED", false);
  }

  async runTurn(input: DeerFlowRunInput): Promise<DeerFlowTurnResult> {
    const threadId = await this.ensureThread(input);
    const rawEvents: DeerFlowRuntimeEvent[] = [];
    let assistantText = "";
    let finalState: unknown;

    await this.streamRun(threadId, input, async (event) => {
      rawEvents.push(event);
      if (event.event === "messages-tuple" && event.content) {
        assistantText += event.content;
      }
      if (event.event === "values") {
        finalState = event.data;
      }
      await input.onEvent?.(event);
    });

    if (!finalState) {
      finalState = await this.getThreadState(threadId).catch(() => undefined);
    }

    const finalAction = extractFinalAction(assistantText, finalState);
    return {
      threadId,
      assistantText: finalAction.message || assistantText.trim(),
      finalAction,
      rawEvents,
      finalState,
    };
  }

  private async ensureThread(input: DeerFlowRunInput) {
    const existing = await this.prisma.deerFlowThreadBinding.findUnique({
      where: { conversationId: input.conversationId },
    });
    if (existing) return existing.deerFlowThreadId;

    const thread = await this.createThread({
      aiProductWorkbenchProjectId: input.projectId,
      aiProductWorkbenchConversationId: input.conversationId,
      aiProductWorkbenchUserId: input.userId,
      source: "ai-product-workbench",
    });

    try {
      const created = await this.prisma.deerFlowThreadBinding.create({
        data: {
          projectId: input.projectId,
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
        if (createdByAnotherTurn) return createdByAnotherTurn.deerFlowThreadId;
      }
      throw error;
    }
  }

  private async createThread(metadata: Record<string, unknown>) {
    const response = await this.requestJson<ThreadCreateResponse>(threadCreatePath(), {
      method: "POST",
      body: JSON.stringify({ metadata }),
    });
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
      headers: jsonHeaders(),
      body: JSON.stringify(buildRunRequest(input)),
    });
    if (!response.ok) {
      throw new Error(`DeerFlow run stream 请求失败：${response.status} ${await safeResponseText(response)}`);
    }
    if (!response.body) {
      throw new Error("DeerFlow run stream 未返回响应体");
    }

    await readSse(response.body, async (event) => {
      await onEvent(normalizeDeerFlowEvent(event.event, event.data));
    });
  }

  private async getThreadState(threadId: string) {
    return this.requestJson(threadStatePath(threadId), { method: "GET" });
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(langGraphUrl(path), {
      ...init,
      headers: {
        ...jsonHeaders(),
        ...(init.headers ?? {}),
      },
    });
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
        model_name: process.env.DEERFLOW_MODEL_NAME || undefined,
        agent_name: process.env.DEERFLOW_AGENT_NAME || undefined,
      },
    },
  };
}

function buildUserPrompt(input: DeerFlowRunInput) {
  const context = {
    runtimeContract: "ai-product-workbench.deerflow-runtime.v1",
    runId: input.runId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    previewMode: input.previewMode,
    selectedRegion: input.selectedRegion,
    attachments: input.attachments ?? [],
    resumeReason: input.resumeReason,
    productDesignState: input.productDesignState,
    finalActionContract: {
      instruction: "At the end, include one fenced block named ai_product_workbench_final_action with JSON.",
      schema: {
        type: "answer | review_prd | review_prototype | ask_clarification | download_export",
        message: "user-facing Chinese summary",
        intent: "optional intent label",
      },
      constraints: [
        "Do not mutate the product database directly.",
        "If coding or prototype execution is needed, use DeerFlow coding/prototype execution capability inside the graph.",
        "Return final action instead of asking NestJS to decide the workflow.",
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

function normalizeDeerFlowEvent(event: string, data: unknown): DeerFlowRuntimeEvent {
  const payload = primaryPayload(data);
  const record = asRecord(payload);
  const content = toContentText(payload);
  return {
    event,
    data,
    content,
    toolName: extractToolName(record) ?? extractToolName(asRecord(data)),
  };
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
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        const itemRecord = asRecord(item);
        return toOptionalString(itemRecord?.text) ?? toOptionalString(itemRecord?.content) ?? "";
      })
      .filter(Boolean)
      .join("");
  }
  return undefined;
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
    raw: parsed ?? { finalState },
  };
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
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSseChunk(part);
      if (event) await onEvent(event);
    }
  }

  buffer += decoder.decode();
  const event = parseSseChunk(buffer);
  if (event) await onEvent(event);
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

function primaryPayload(data: unknown) {
  if (Array.isArray(data)) return data[0] ?? data;
  return data;
}

function readStreamMode() {
  const modes = (process.env.DEERFLOW_STREAM_MODE ?? "messages-tuple")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (modes.length <= 1) return modes[0] ?? "messages-tuple";
  return modes;
}

function langGraphUrl(path: string) {
  return joinUrl(process.env.DEERFLOW_LANGGRAPH_URL ?? "http://localhost:2024", path);
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

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function jsonHeaders() {
  return { "content-type": "application/json", accept: "application/json, text/event-stream" };
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const timeoutMs = readNumberEnv("DEERFLOW_TIMEOUT_MS", 600_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
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

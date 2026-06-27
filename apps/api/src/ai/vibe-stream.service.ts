import { Injectable, MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  RuntimeStreamStepName,
  VibeStreamEvent,
  VibeStreamEventCategory,
  VibeStreamEventEnvelope,
  VibeStreamEventPhase,
  VibeStreamPayloadKind,
  VibeStreamPayloadMeta,
  VibeStreamEventType,
  VibeStreamLegacyEventType,
} from "./ai-vibe.types";

type Listener = (event: VibeStreamEvent) => void;

type PersistedVibeStreamEvent = {
  protocol: "vibe.v1";
  eventId: string;
  eventType: VibeStreamEventType;
  legacyEventType: VibeStreamLegacyEventType;
  category: VibeStreamEventCategory;
  phase: VibeStreamEventPhase;
  timestamp: string;
  runId: string;
  projectId: string;
  payload: VibeStreamEventEnvelope;
};

@Injectable()
export class VibeStreamService {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly prisma: PrismaService) {}

  async emit(input: {
    runId: string;
    projectId: string;
    type: VibeStreamEventType;
    step?: VibeStreamEvent["step"];
    content?: string;
    data?: unknown;
  }) {
    const event = buildStreamEvent(input);
    const persistedEvent: PersistedVibeStreamEvent = {
      protocol: event.protocol,
      eventId: event.eventId,
      eventType: event.eventType,
      legacyEventType: event.legacyEventType,
      category: event.category,
      phase: event.phase,
      timestamp: event.createdAt,
      runId: input.runId,
      projectId: input.projectId,
      payload: event,
    };

    await this.prisma.vibeStreamEventLog.create({
      data: {
        runId: input.runId,
        projectId: input.projectId,
        eventType: persistedEvent.eventType,
        payload: toInputJson(persistedEvent),
      },
    });

    this.listeners.get(input.runId)?.forEach((listener) => listener(event));
    return event;
  }

  async getEvents(runId: string) {
    const events = await this.prisma.vibeStreamEventLog.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
    });

    return events
      .map((event) => unwrapContractPayload(event.payload))
      .filter((event): event is VibeStreamEvent => Boolean(event));
  }

  stream(runId: string) {
    return new Observable<MessageEvent>((subscriber) => {
      let active = true;
      const listener: Listener = (event) => {
        if (!active) return;
        subscriber.next({
          type: event.type,
          data: event,
        });
      };

      void this.getEvents(runId).then((events) => {
        if (!active) return;
        events.forEach(listener);
      });

      const runListeners = this.listeners.get(runId) ?? new Set<Listener>();
      runListeners.add(listener);
      this.listeners.set(runId, runListeners);

      return () => {
        active = false;
        runListeners.delete(listener);
        if (!runListeners.size) this.listeners.delete(runId);
      };
    });
  }
}

function buildStreamEvent(input: {
  runId: string;
  projectId: string;
  type: VibeStreamEventType;
  step?: VibeStreamEvent["step"];
  content?: string;
  data?: unknown;
}): VibeStreamEventEnvelope {
  const createdAt = new Date().toISOString();
  const { category, phase } = classifyStreamEvent(input.type);
  const legacyEventType = toLegacyEventType(input.type, input.step);
  return {
    protocol: "vibe.v1",
    eventId: createEventId(input.runId, input.type, input.step),
    runId: input.runId,
    projectId: input.projectId,
    type: input.type,
    eventType: input.type,
    legacyEventType,
    category,
    phase,
    step: input.step,
    content: input.content,
    payloadMeta: buildPayloadMeta(input.type, input.step, input.data, input.content),
    payload: input.data,
    data: input.data,
    createdAt,
  };
}

function classifyStreamEvent(type: VibeStreamEventType): {
  category: VibeStreamEventCategory;
  phase: VibeStreamEventPhase;
} {
  switch (type) {
    case "step_started":
      return { category: "runtime", phase: "started" };
    case "step_completed":
      return { category: "runtime", phase: "completed" };
    case "step_failed":
      return { category: "runtime", phase: "failed" };
    case "message_delta":
      return { category: "runtime", phase: "progress" };
    case "state_updated":
      return { category: "state", phase: "updated" };
    case "state_version_created":
      return { category: "state", phase: "created" };
    case "prd_updated":
      return { category: "prd", phase: "updated" };
    case "prototype_updated":
      return { category: "prototype", phase: "updated" };
    case "qa_completed":
      return { category: "qa", phase: "completed" };
    case "rollback_started":
      return { category: "rollback", phase: "started" };
    case "rollback_completed":
      return { category: "rollback", phase: "completed" };
    case "rollback_failed":
      return { category: "rollback", phase: "failed" };
    case "knowledge_candidate_created":
      return { category: "knowledge", phase: "created" };
    case "export_ready":
      return { category: "export", phase: "completed" };
    case "run_completed":
      return { category: "run", phase: "completed" };
    case "run_canceled":
      return { category: "run", phase: "canceled" };
    case "run_failed":
      return { category: "run", phase: "failed" };
  }
}

function toLegacyEventType(
  type: VibeStreamEventType,
  step?: VibeStreamEvent["step"],
): VibeStreamLegacyEventType {
  if (type === "state_updated") return "state_updated";
  if (type === "state_version_created") return "state_version_created";
  if (type === "prd_updated") return "prd_generated";
  if (type === "prototype_updated") return "prototype_generated";
  if (type === "qa_completed") return "qa_completed";
  if (type === "knowledge_candidate_created") return "state_updated";
  if (type === "export_ready") return "agent_completed";
  if (type === "step_started" || type === "message_delta") return "agent_started";
  return "agent_completed";
}

function unwrapContractPayload(payload: unknown): VibeStreamEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const innerPayload = asRecord(record.payload);
  if (innerPayload?.type && typeof innerPayload.type === "string") {
    return normalizeStreamEvent(innerPayload, record);
  }
  if (typeof record.type === "string") {
    return normalizeStreamEvent(record);
  }
  return null;
}

function normalizeStreamEvent(
  payload: Record<string, unknown>,
  outer?: Record<string, unknown>,
): VibeStreamEvent | null {
  const type = payload.type;
  const runId = payload.runId;
  const createdAt = toOptionalString(payload.createdAt) ?? toOptionalString(outer?.timestamp);
  if (typeof type !== "string" || typeof runId !== "string" || !createdAt) return null;

  const eventType = type as VibeStreamEventType;
  const step = toOptionalString(payload.step) as RuntimeStreamStepName | undefined;
  const { category, phase } = classifyStreamEvent(eventType);
  const data = payload.payload ?? payload.data;
  const content = toOptionalString(payload.content);
  return {
    protocol: "vibe.v1",
    eventId:
      toOptionalString(payload.eventId)
      ?? toOptionalString(outer?.eventId)
      ?? createEventId(runId, eventType, step),
    runId,
    projectId: toOptionalString(payload.projectId) ?? toOptionalString(outer?.projectId),
    type: eventType,
    eventType,
    legacyEventType:
      (toOptionalString(payload.legacyEventType) as VibeStreamLegacyEventType | undefined)
      ?? (toOptionalString(outer?.legacyEventType) as VibeStreamLegacyEventType | undefined)
      ?? toLegacyEventType(eventType, step),
    category:
      (toOptionalString(payload.category) as VibeStreamEventCategory | undefined)
      ?? (toOptionalString(outer?.category) as VibeStreamEventCategory | undefined)
      ?? category,
    phase:
      (toOptionalString(payload.phase) as VibeStreamEventPhase | undefined)
      ?? (toOptionalString(outer?.phase) as VibeStreamEventPhase | undefined)
      ?? phase,
    step,
    content,
    payloadMeta: normalizePayloadMeta(payload.payloadMeta)
      ?? normalizePayloadMeta(outer?.payloadMeta)
      ?? buildPayloadMeta(eventType, step, data, content),
    payload: data,
    data,
    createdAt,
  };
}

function buildPayloadMeta(
  type: VibeStreamEventType,
  step?: RuntimeStreamStepName,
  data?: unknown,
  content?: string,
): VibeStreamPayloadMeta {
  const record = asRecord(data);
  const qaReport = asRecord(record?.qaReport) ?? (type === "qa_completed" ? record : undefined);
  const qaGate = asRecord(record?.qaGate) ?? asRecord(qaReport?.gate);
  const prototypeArtifact = asRecord(record?.prototypeArtifact) ?? (type === "prototype_updated" ? record : undefined);
  const prototypeSpec = asRecord(record?.prototypeSpec);
  const nextAction = asRecord(record?.nextAction);

  return stripUndefined({
    schema: "vibe.stream.payload.v1",
    kind: payloadKindForType(type),
    primaryId:
      text(qaReport?.id)
      ?? text(record?.id)
      ?? text(record?.sourceId),
    secondaryId:
      text(prototypeSpec?.id)
      ?? text(record?.prototypeSpecId)
      ?? text(prototypeArtifact?.prototypeSpecId),
    status:
      text(qaGate?.status)
      ?? text(qaReport?.status)
      ?? text(record?.status)
      ?? text(record?.level)
      ?? (type === "run_failed"
        ? "failed"
        : type === "run_canceled"
          ? "cancelled"
          : type === "run_completed"
            ? "completed"
            : undefined),
    title:
      text(record?.title)
      ?? text(record?.fileName)
      ?? text(prototypeArtifact?.title),
    summary:
      content
      ?? text(record?.message)
      ?? text(record?.summary)
      ?? text(qaReport?.summary),
    action: text(nextAction?.type) ?? text(record?.action),
    counts: payloadCounts(type, record, qaReport),
    refs: payloadRefs(type, record, qaReport, prototypeArtifact),
  });
}

function payloadKindForType(type: VibeStreamEventType): VibeStreamPayloadKind {
  if (type === "step_started" || type === "step_completed" || type === "step_failed") return "runtime_step";
  if (type === "message_delta") return "progress";
  if (type === "state_updated" || type === "state_version_created") return "state";
  if (type === "prd_updated") return "prd";
  if (type === "prototype_updated") return "prototype";
  if (type === "qa_completed") return "qa";
  if (type.startsWith("rollback_")) return "rollback";
  if (type === "knowledge_candidate_created") return "knowledge";
  if (type === "export_ready") return "export";
  return "run";
}

function payloadCounts(
  type: VibeStreamEventType,
  record?: Record<string, unknown>,
  qaReport?: Record<string, unknown>,
) {
  if (type === "qa_completed") {
    return stripNumberRecord({
      blocking: numberValue(qaReport?.blockingCount),
      major: numberValue(qaReport?.majorCount),
      minor: numberValue(qaReport?.minorCount),
      info: numberValue(qaReport?.infoCount),
      issues: Array.isArray(qaReport?.issues) ? qaReport.issues.length : undefined,
    });
  }
  const counts = asRecord(record?.counts);
  if (counts) return stripNumberRecord(counts);
  if (type === "knowledge_candidate_created") {
    return stripNumberRecord({ candidates: Array.isArray(record?.items) ? record.items.length : undefined });
  }
  return undefined;
}

function payloadRefs(
  type: VibeStreamEventType,
  record?: Record<string, unknown>,
  qaReport?: Record<string, unknown>,
  prototypeArtifact?: Record<string, unknown>,
) {
  const refs = stripStringRecord({
    stateId:
      text(record?.stateId)
      ?? text(record?.productDesignStateId)
      ?? text(qaReport?.productDesignStateId)
      ?? text(prototypeArtifact?.productDesignStateId),
    prdDocumentId: text(record?.prdDocumentId) ?? text(qaReport?.prdDocumentId),
    prototypeArtifactId:
      text(record?.prototypeArtifactId)
      ?? text(qaReport?.prototypeArtifactId)
      ?? text(prototypeArtifact?.id),
    qaReportId: text(qaReport?.id),
  });
  return Object.keys(refs).length ? refs : undefined;
}

function normalizePayloadMeta(value: unknown): VibeStreamPayloadMeta | undefined {
  const record = asRecord(value);
  if (!record || record.schema !== "vibe.stream.payload.v1") return undefined;
  const kind = text(record.kind) as VibeStreamPayloadKind | undefined;
  if (!kind) return undefined;
  const meta: VibeStreamPayloadMeta = {
    schema: "vibe.stream.payload.v1",
    kind,
  };
  const primaryId = text(record.primaryId);
  const secondaryId = text(record.secondaryId);
  const status = text(record.status);
  const title = text(record.title);
  const summary = text(record.summary);
  const action = text(record.action);
  const counts = stripNumberRecord(asRecord(record.counts));
  const refs = stripStringRecord(asRecord(record.refs));
  if (primaryId) meta.primaryId = primaryId;
  if (secondaryId) meta.secondaryId = secondaryId;
  if (status) meta.status = status;
  if (title) meta.title = title;
  if (summary) meta.summary = summary;
  if (action) meta.action = action;
  if (counts) meta.counts = counts;
  if (Object.keys(refs).length) meta.refs = refs;
  return meta;
}

function createEventId(runId: string, type: VibeStreamEventType, step?: RuntimeStreamStepName) {
  const stepPart = step ? `:${step}` : "";
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${runId}:${type}${stepPart}:${Date.now().toString(36)}:${nonce}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toOptionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}

function stripNumberRecord(record?: Record<string, unknown>) {
  if (!record) return undefined;
  const result = Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
  return Object.keys(result).length ? result : undefined;
}

function stripStringRecord(record?: Record<string, unknown>) {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => [key, text(value)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

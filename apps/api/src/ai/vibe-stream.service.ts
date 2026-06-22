import { Injectable, MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  AgentStepName,
  VibeStreamEvent,
  VibeStreamEventCategory,
  VibeStreamEventEnvelope,
  VibeStreamEventPhase,
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
      return { category: "agent", phase: "started" };
    case "step_completed":
      return { category: "agent", phase: "completed" };
    case "step_failed":
      return { category: "agent", phase: "failed" };
    case "message_delta":
      return { category: "agent", phase: "progress" };
    case "state_updated":
      return { category: "state", phase: "updated" };
    case "state_version_created":
      return { category: "state", phase: "created" };
    case "prd_updated":
      return { category: "prd", phase: "updated" };
    case "prototype_updated":
      return { category: "prototype", phase: "updated" };
    case "patch_started":
      return { category: "patch", phase: "started" };
    case "patch_plan_created":
      return { category: "patch", phase: "created" };
    case "patch_applying":
      return { category: "patch", phase: "applying" };
    case "patch_completed":
      return { category: "patch", phase: "completed" };
    case "patch_failed":
      return { category: "patch", phase: "failed" };
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
    case "run_completed":
      return { category: "run", phase: "completed" };
    case "run_failed":
      return { category: "run", phase: "failed" };
  }
}

function toLegacyEventType(
  type: VibeStreamEventType,
  step?: VibeStreamEvent["step"],
): VibeStreamLegacyEventType {
  if (type === "state_updated" && step === "patch_planning") return "patch_applied";
  if (type === "state_updated") return "state_updated";
  if (type === "state_version_created") return "state_version_created";
  if (type === "prd_updated") return "prd_generated";
  if (type === "prototype_updated") return "prototype_generated";
  if (
    type === "patch_started" ||
    type === "patch_plan_created" ||
    type === "patch_applying" ||
    type === "patch_completed" ||
    type === "patch_failed"
  ) {
    return "patch_applied";
  }
  if (type === "qa_completed") return "qa_completed";
  if (type === "knowledge_candidate_created") return "state_updated";
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
  const step = toOptionalString(payload.step) as AgentStepName | undefined;
  const { category, phase } = classifyStreamEvent(eventType);
  const data = payload.payload ?? payload.data;
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
    content: toOptionalString(payload.content),
    payload: data,
    data,
    createdAt,
  };
}

function createEventId(runId: string, type: VibeStreamEventType, step?: AgentStepName) {
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

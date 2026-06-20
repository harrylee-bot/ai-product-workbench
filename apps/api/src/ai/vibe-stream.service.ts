import { Injectable, MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type { VibeStreamEvent, VibeStreamEventType } from "./ai-vibe.types";

type Listener = (event: VibeStreamEvent) => void;

type ContractEventType =
  | "agent_started"
  | "agent_completed"
  | "state_updated"
  | "state_version_created"
  | "prd_generated"
  | "prototype_generated"
  | "patch_applied"
  | "qa_completed";

type ContractEvent = {
  eventType: ContractEventType;
  timestamp: string;
  projectId: string;
  payload: VibeStreamEvent;
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
    const event: VibeStreamEvent = {
      runId: input.runId,
      type: input.type,
      step: input.step,
      content: input.content,
      data: input.data,
      createdAt: new Date().toISOString(),
    };
    const contractEvent: ContractEvent = {
      eventType: toContractEventType(input.type, input.step),
      timestamp: event.createdAt,
      projectId: input.projectId,
      payload: event,
    };

    await this.prisma.vibeStreamEventLog.create({
      data: {
        runId: input.runId,
        projectId: input.projectId,
        eventType: contractEvent.eventType,
        payload: toInputJson(contractEvent),
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

function toContractEventType(
  type: VibeStreamEventType,
  step?: VibeStreamEvent["step"],
): ContractEventType {
  if (type === "state_updated" && step === "patch_planning") return "patch_applied";
  if (type === "state_updated") return "state_updated";
  if (type === "prd_updated") return "prd_generated";
  if (type === "prototype_updated") return "prototype_generated";
  if (type === "qa_completed") return "qa_completed";
  if (type === "knowledge_candidate_created") return "state_updated";
  if (type === "step_started" || type === "message_delta") return "agent_started";
  return "agent_completed";
}

function unwrapContractPayload(payload: unknown): VibeStreamEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { payload?: unknown; type?: unknown };
  if (record.payload && typeof record.payload === "object") {
    return record.payload as VibeStreamEvent;
  }
  if (typeof record.type === "string") {
    return record as VibeStreamEvent;
  }
  return null;
}

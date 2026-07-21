import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { RunEvent } from "@workbench/workbench-contracts";
import { validationProblem } from "../../common/problem-details.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { RunsService, validateIdempotencyKey } from "./runs.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get("threads/:threadId/runs")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.runs.list(principal.id, threadId, cursor, parseLimit(limit));
  }

  @Get("runs/:runId")
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
  ) {
    return this.runs.get(principal.id, runId);
  }

  @Get("runs/:runId/events")
  async events(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Query("afterSequence") afterSequence: string | undefined,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    let cursor = parseEventCursor(afterSequence, lastEventId);
    await this.runs.authorizeEventStream(principal.id, runId);

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const connection = createSseConnection(request, response);
    let lastHeartbeat = Date.now();
    try {
      while (!connection.signal.aborted) {
        const poll = await this.runs.pollAuthorizedEventStream(principal.id, runId, cursor);
        if (!poll) break;
        for (const event of poll.events) {
          if (connection.signal.aborted) break;
          if (!await writeSse(response, event, connection.signal)) break;
          cursor = event.sequence;
        }

        if (connection.signal.aborted) break;
        if (this.runs.isTerminal(poll.status) && poll.events.length === 0) break;
        if (Date.now() - lastHeartbeat >= 15_000) {
          if (!await writeSseChunk(response, `: heartbeat ${Date.now()}\n\n`, connection.signal)) break;
          lastHeartbeat = Date.now();
        }
        await delay(500, connection.signal);
      }
    } finally {
      connection.cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }

  @Post("runs/:runId/cancel")
  @HttpCode(202)
  cancel(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    validateIdempotencyKey(idempotencyKey);
    return this.runs.cancel(principal.id, runId, idempotencyKey);
  }

  @Post("runs/:runId/retry")
  @HttpCode(202)
  async retry(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    validateIdempotencyKey(idempotencyKey);
    const run = await this.runs.retry(principal.id, runId, idempotencyKey);
    response.setHeader("Location", `/api/v1/runs/${run.id}`);
    return run;
  }
}

function parseLimit(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function parseEventCursor(afterSequence?: string, lastEventId?: string) {
  const normalized = [afterSequence, lastEventId]
    .filter((value): value is string => value !== undefined && value !== "")
    .map((value) => (/^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN));
  if (normalized.some((value) => !Number.isSafeInteger(value))) {
    throw validationProblem("afterSequence and Last-Event-ID must be non-negative integers");
  }
  if (normalized.length === 2 && normalized[0] !== normalized[1]) {
    throw validationProblem("afterSequence and Last-Event-ID must match when both are provided");
  }
  return normalized[0] ?? 0;
}

export function serializeSseEvent(event: RunEvent) {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function writeSse(response: Response, event: RunEvent, signal?: AbortSignal) {
  return writeSseChunk(response, serializeSseEvent(event), signal);
}

async function writeSseChunk(response: Response, chunk: string, signal?: AbortSignal) {
  if (signal?.aborted || response.destroyed || response.writableEnded) return false;
  try {
    if (response.write(chunk)) return true;
  } catch {
    return false;
  }
  return waitForWritable(response, signal);
}

function waitForWritable(response: Response, signal?: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    const socket = response.socket;
    let settled = false;
    const finish = (writable: boolean) => {
      if (settled) return;
      settled = true;
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      socket?.off("close", onSocketClose);
      socket?.off("error", onSocketError);
      signal?.removeEventListener("abort", onAbort);
      resolve(writable);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    const onSocketClose = () => finish(false);
    const onSocketError = () => finish(false);
    const onAbort = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    socket?.once("close", onSocketClose);
    socket?.once("error", onSocketError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (
      signal?.aborted
      || response.destroyed
      || response.writableEnded
      || socket?.destroyed
    ) finish(false);
  });
}

export function createSseConnection(request: Request, response: Response) {
  const controller = new AbortController();
  const socket = response.socket ?? request.socket;
  const abort = () => controller.abort();
  // Request `close` means the inbound request body finished; it is not a
  // reliable indication that the outbound SSE socket closed.
  request.once("aborted", abort);
  response.once("close", abort);
  response.once("error", abort);
  socket.once("close", abort);
  socket.once("error", abort);
  if (request.aborted || response.destroyed || socket.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abort);
      response.off("error", abort);
      socket.off("close", abort);
      socket.off("error", abort);
    },
  };
}

function delay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

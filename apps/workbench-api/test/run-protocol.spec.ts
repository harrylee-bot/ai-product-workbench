import { EventEmitter, once } from "node:events";
import { createServer, get, type ServerResponse } from "node:http";
import {
  RunsController,
  createSseConnection,
  parseEventCursor,
  serializeSseEvent,
  writeSse,
} from "../src/modules/runs/runs.controller.js";
import {
  assertRunWorkflowInputs,
  hashRequest,
  runRequestHash,
  validateIdempotencyKey,
} from "../src/modules/runs/runs.service.js";

describe("Run HTTP and SSE protocol", () => {
  it("requires one unambiguous client cursor", () => {
    expect(parseEventCursor(undefined, "9")).toBe(9);
    expect(parseEventCursor("7", undefined)).toBe(7);
    expect(() => parseEventCursor("7", "9")).toThrow();
    expect(parseEventCursor("7", "7")).toBe(7);
    expect(parseEventCursor(undefined, undefined)).toBe(0);
    for (const invalid of ["-1", "1.2", "1e2", "+1", " 1", "01", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parseEventCursor(invalid)).toThrow();
    }
  });

  it.each([
    ["response close", (response: EventEmitter) => response.emit("close")],
    ["response error", (response: EventEmitter) => response.emit("error", new Error("response reset"))],
    ["socket close", (_response: EventEmitter, socket: EventEmitter) => socket.emit("close")],
    ["socket error", (_response: EventEmitter, socket: EventEmitter) => socket.emit("error", new Error("socket reset"))],
    ["abort", (_response: EventEmitter, _socket: EventEmitter, controller: AbortController) => controller.abort()],
  ])("settles a backpressured SSE write on %s", async (_label, terminate) => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      socket,
      write: () => false,
    });
    const event = {
      protocol: "workbench.run.v1" as const,
      id: "event_close",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      requestId: "request_1",
      sequence: 1,
      occurredAt: "2026-07-12T00:00:00.000Z",
      traceId: "trace_1",
      type: "run.started" as const,
      payload: {},
    };
    const controller = new AbortController();
    const pending = writeSse(response as never, event, controller.signal);
    terminate(response, socket, controller);
    await expect(pending).resolves.toBe(false);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });

  it("resumes a backpressured SSE write on drain and removes termination listeners", async () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      socket,
      write: () => false,
    });
    const pending = writeSse(response as never, runEvent(), new AbortController().signal);

    response.emit("drain");

    await expect(pending).resolves.toBe(true);
    expect(response.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("exits a backpressured event stream when the real client socket closes", async () => {
    let pollCount = 0;
    const controller = new RunsController({
      authorizeEventStream: vi.fn().mockResolvedValue(undefined),
      pollAuthorizedEventStream: vi.fn().mockImplementation(async () => {
        pollCount += 1;
        return {
          events: [{
            ...runEvent(),
            payload: { text: "x".repeat(8 * 1024 * 1024) },
          }],
          status: "running",
        };
      }),
      isTerminal: vi.fn().mockReturnValue(false),
    } as never);
    let settleServer: () => void = () => undefined;
    let rejectServer: (error: unknown) => void = () => undefined;
    const serverResult = new Promise<void>((resolve, reject) => {
      settleServer = resolve;
      rejectServer = reject;
    });
    const server = createServer((request, response) => {
      addExpressStatus(response);
      void controller.events(
        { id: "principal_socket_test" } as never,
        "run_socket_test",
        undefined,
        undefined,
        request as never,
        response as never,
      ).then(settleServer, rejectServer);
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("SSE test server did not bind a TCP port");
      await new Promise<void>((resolve, reject) => {
        const client = get(`http://127.0.0.1:${address.port}/runs/run_socket_test/events`, (response) => {
          response.pause();
          response.destroy();
          resolve();
        });
        client.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") resolve();
          else reject(error);
        });
      });

      await expect(withTimeout(serverResult, 2_000)).resolves.toBeUndefined();
      expect(pollCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("uses outbound lifecycle signals and ignores request close and socket half-close", () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const request = Object.assign(new EventEmitter(), { aborted: false, socket });
    const response = Object.assign(new EventEmitter(), { destroyed: false, socket });
    const connection = createSseConnection(request as never, response as never);

    request.emit("close");
    socket.emit("end");
    expect(connection.signal.aborted).toBe(false);

    response.emit("close");
    expect(connection.signal.aborted).toBe(true);
    connection.cleanup();
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it.each([
    ["request abort", (request: EventEmitter) => request.emit("aborted")],
    ["response error", (_request: EventEmitter, response: EventEmitter) => response.emit("error", new Error("response reset"))],
    ["socket close", (_request: EventEmitter, _response: EventEmitter, socket: EventEmitter) => socket.emit("close")],
    ["socket error", (_request: EventEmitter, _response: EventEmitter, socket: EventEmitter) => socket.emit("error", new Error("socket reset"))],
  ])("aborts the SSE connection on %s", (_label, terminate) => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const request = Object.assign(new EventEmitter(), { aborted: false, socket });
    const response = Object.assign(new EventEmitter(), { destroyed: false, socket });
    const connection = createSseConnection(request as never, response as never);

    terminate(request, response, socket);

    expect(connection.signal.aborted).toBe(true);
    connection.cleanup();
  });

  it("uses sequence as the SSE id and sends the versioned event", () => {
    const event = {
      protocol: "workbench.run.v1" as const,
      id: "event_1",
      projectId: "project_1",
      threadId: "thread_1",
      runId: "run_1",
      requestId: "request_1",
      sequence: 3,
      occurredAt: "2026-07-12T00:00:00.000Z",
      traceId: "trace_1",
      type: "run.completed" as const,
      payload: { artifactCount: 2 },
    };
    const wire = serializeSseEvent(event);
    expect(wire).toContain("id: 3\n");
    expect(wire).toContain("event: run.completed\n");
    expect(wire).toContain('"protocol":"workbench.run.v1"');
  });

  it("validates and hashes idempotent commands", () => {
    expect(() => validateIdempotencyKey("request:12345678")).not.toThrow();
    expect(() => validateIdempotencyKey("short")).toThrow();
    const request = {
      prompt: "Create a PRD",
      modelId: "quality",
      workflow: "edit" as const,
      generationIntent: null,
      targetSurface: "app" as const,
      designStyle: { kind: "automatic" as const },
      sourceIds: [],
      artifactTargets: [
        { artifactId: "artifact_2", artifactVersionId: "version_2", screenIds: ["screen_2"] },
        { artifactId: "artifact_1", artifactVersionId: "version_1", screenIds: [] },
      ],
      requestedArtifactKinds: ["prd" as const],
    };
    expect(hashRequest(request)).toBe(hashRequest({ ...request }));
    expect(hashRequest({ ...request, prompt: "Create a prototype" })).not.toBe(hashRequest(request));
    expect(hashRequest({
      ...request,
      artifactTargets: [...request.artifactTargets].reverse(),
    })).not.toBe(hashRequest(request));
    expect(runRequestHash(request, "a".repeat(64)))
      .not.toBe(runRequestHash(request, "b".repeat(64)));
    expect(runRequestHash(request, null)).toBe(hashRequest(request));
  });

  it("rejects an Edit Run without Artifact targets as a field-addressed 400", () => {
    expect(() => assertRunWorkflowInputs({
      workflow: "generate",
      generationIntent: null,
      artifactTargets: [],
      requestedArtifactKinds: [],
    }))
      .not.toThrow();

    let failure: unknown;
    try {
      assertRunWorkflowInputs({ workflow: "edit", generationIntent: null, artifactTargets: [], requestedArtifactKinds: [] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 400,
      response: {
        code: "VALIDATION_ERROR",
        detail: "The edit workflow requires at least one Artifact target",
        errors: {
          artifactTargets: ["Select at least one ready ArtifactVersion or Prototype screen"],
        },
      },
    });

    expect(() => assertRunWorkflowInputs({
      workflow: "generate",
      generationIntent: "interactive-prototype",
      requestedArtifactKinds: ["prd"],
      artifactTargets: [{
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenIds: ["screen_1"],
      }],
    })).toThrow(expect.objectContaining({
      status: 400,
      response: expect.objectContaining({
        detail: "Generate Artifact targets require a Prototype output",
        errors: {
          requestedArtifactKinds: ["Include prototype when selecting source screens"],
        },
      }),
    }));

    expect(() => assertRunWorkflowInputs({
      workflow: "generate",
      generationIntent: "interactive-prototype",
      requestedArtifactKinds: ["prototype"],
      artifactTargets: [{
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenIds: [],
      }],
    })).toThrow(expect.objectContaining({
      status: 400,
      response: expect.objectContaining({
        detail: "Generate Prototype requires explicit screen selections",
        errors: {
          "artifactTargets.0.screenIds": ["Select at least one source Prototype screen"],
        },
      }),
    }));

    expect(() => assertRunWorkflowInputs({
      workflow: "generate",
      generationIntent: "followup-design",
      requestedArtifactKinds: ["prototype"],
      artifactTargets: [{
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenIds: ["screen_1"],
      }],
    })).not.toThrow();

    for (const workflow of ["redesign", "ideate"] as const) {
      expect(() => assertRunWorkflowInputs({
        workflow,
        generationIntent: null,
        requestedArtifactKinds: ["prototype"],
        artifactTargets: [{
          artifactId: "artifact_1",
          artifactVersionId: "version_1",
          screenIds: ["screen_1"],
        }],
      })).toThrow(expect.objectContaining({
        status: 400,
        response: expect.objectContaining({
          detail: "Artifact targets are not valid for the redesign or ideate workflows",
          errors: expect.objectContaining({ artifactTargets: expect.any(Array) }),
        }),
      }));
    }
  });
});

function runEvent() {
  return {
    protocol: "workbench.run.v1" as const,
    id: "event_1",
    projectId: "project_1",
    threadId: "thread_1",
    runId: "run_1",
    requestId: "request_1",
    sequence: 1,
    occurredAt: "2026-07-12T00:00:00.000Z",
    traceId: "trace_1",
    type: "run.started" as const,
    payload: {},
  };
}

function addExpressStatus(response: ServerResponse) {
  Object.assign(response, {
    status(code: number) {
      response.statusCode = code;
      return response;
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

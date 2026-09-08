import "reflect-metadata";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProblemDetailsFilter } from "../src/common/problem-details.filter.js";
import { IdentityService } from "../src/modules/identity/identity.service.js";
import type { AuthenticatedPrincipal } from "../src/modules/identity/identity.types.js";
import { WorkbenchAuthGuard } from "../src/modules/identity/workbench-auth.guard.js";
import { RunsService } from "../src/modules/runs/runs.service.js";
import { SubmissionIntentsController } from "../src/modules/submission-intents/submission-intents.controller.js";
import { SubmissionIntentsService } from "../src/modules/submission-intents/submission-intents.service.js";

const mixedRequest = {
  request: {
    prompt: "Create a PRD and a prototype",
    modelId: "quality",
    workflow: "generate",
    generationIntent: null,
    targetSurface: "web",
    designStyle: { kind: "automatic" },
    sourceIds: [],
    artifactTargets: [],
    requestedArtifactKinds: ["prd", "prototype"],
    canvasSnapshot: null,
  },
  attachments: [],
};

const authenticatedPrincipal: AuthenticatedPrincipal = {
  id: "principal_http_1",
  issuer: "urn:workbench:development",
  subject: "http-mixed-request-principal",
  email: "http-mixed-request@example.test",
  displayName: "HTTP mixed request principal",
  defaultWorkspaceId: "workspace_http_1",
};

type HttpResult = Readonly<{
  status: number;
  contentType: string | null;
  body: Record<string, unknown>;
}>;

type SideEffectProbe = ReturnType<typeof sideEffectProbe>;

describe("SubmissionIntent authenticated HTTP mixed-request boundary", () => {
  const applications: NestExpressApplication[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("authenticates before mixed validation without disclosing Thread existence", async () => {
    const harness = await httpHarness(applications);

    const existing = await postMixed(
      harness.endpoint("thread_existing"),
      "submission:http:unauthenticated:12345678",
    );
    const missing = await postMixed(
      harness.endpoint("thread_missing"),
      "submission:http:unauthenticated:12345678",
    );

    expect(publicProblem(existing.body)).toEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Missing x-workbench-dev-subject",
      code: "HTTP_401",
    });
    expect(publicProblem(missing.body)).toEqual(publicProblem(existing.body));
    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(existing.contentType).toMatch(/^application\/problem\+json\b/u);
    expect(missing.contentType).toMatch(/^application\/problem\+json\b/u);
    expect(existing.body).not.toHaveProperty("errors");
    expect(missing.body).not.toHaveProperty("errors");
    expect(JSON.stringify([existing.body, missing.body])).not.toContain("two sequential Runs");
    expect(harness.identity.resolvePrincipal).toHaveBeenCalledTimes(0);
    expectNoSideEffects(harness.probe);
  });

  it("returns stable ProblemDetails for authenticated idempotent replay with zero side effects", async () => {
    const harness = await httpHarness(applications);
    const endpoint = harness.endpoint("thread_private_1");
    const idempotencyKey = "submission:http:mixed-replay:12345678";

    const first = await postMixed(endpoint, idempotencyKey, {
      "x-workbench-dev-subject": authenticatedPrincipal.subject,
    });
    const replay = await postMixed(endpoint, idempotencyKey, {
      "x-workbench-dev-subject": authenticatedPrincipal.subject,
    });

    const expectedProblem = {
      type: "about:blank",
      title: "Invalid request",
      status: 400,
      detail: "The request body does not match the contract",
      instance: "/api/v1/threads/thread_private_1/submission-intents",
      code: "VALIDATION_ERROR",
      errors: {
        "request.requestedArtifactKinds": [
          "PRD must be requested in its own Run: complete the PRD Run before requesting other artifact kinds",
        ],
      },
    };
    expect(first).toMatchObject({
      status: 400,
      contentType: expect.stringMatching(/^application\/problem\+json\b/u),
      body: expectedProblem,
    });
    expect(replay).toEqual(first);
    expect(harness.identity.resolvePrincipal).toHaveBeenCalledTimes(2);
    expect(harness.identity.resolvePrincipal).toHaveBeenNthCalledWith(1, {
      issuer: "urn:workbench:development",
      subject: authenticatedPrincipal.subject,
      email: undefined,
      displayName: undefined,
    });
    expectNoSideEffects(harness.probe);
  });
});

async function httpHarness(applications: NestExpressApplication[]) {
  const probe = sideEffectProbe();
  const db = {
    $transaction: probe.persistence.transaction,
    $queryRaw: probe.persistence.rawRead,
    $executeRaw: probe.persistence.rawWrite,
    submissionIntent: {
      findUnique: probe.persistence.submissionIntentRead,
      findFirst: probe.persistence.submissionIntentRead,
      findUniqueOrThrow: probe.persistence.submissionIntentRead,
      create: probe.persistence.submissionIntentWrite,
      update: probe.persistence.submissionIntentWrite,
      updateMany: probe.persistence.submissionIntentWrite,
      count: probe.persistence.submissionIntentRead,
    },
    submissionIntentAttachment: {
      create: probe.persistence.submissionIntentAttachmentWrite,
      createMany: probe.persistence.submissionIntentAttachmentWrite,
    },
    run: {
      findUnique: probe.persistence.runRead,
      findFirst: probe.persistence.runRead,
      create: probe.persistence.runWrite,
      count: probe.persistence.runRead,
    },
    runtimeAttempt: {
      create: probe.persistence.runtimeAttemptWrite,
      count: probe.persistence.runtimeAttemptRead,
    },
    artifactVersion: {
      create: probe.persistence.artifactVersionWrite,
      count: probe.persistence.artifactVersionRead,
    },
    runEvent: {
      create: probe.persistence.runEventWrite,
      count: probe.persistence.runEventRead,
    },
  };
  const access = {
    findThread: probe.access,
    findRun: vi.fn(),
  };
  const events = {
    append: probe.runEventAppend,
  };
  probe.queuePublish.mockImplementation(async () => {
    await probe.workerProviderInvocation();
    return "job_http_mixed_request";
  });
  const queue = {
    sendInTransaction: probe.queuePublish,
  };
  const runtimeModels = {
    assertAvailable: probe.runtimeProvider,
  };
  const runs = new RunsService(
    db as never,
    access as never,
    events as never,
    queue as never,
    runtimeModels as never,
    { resolve: vi.fn() } as never,
  );
  probe.runStart = vi.spyOn(runs, "start");
  const intents = new SubmissionIntentsService(
    db as never,
    access as never,
    runs,
    runtimeModels as never,
    { materializeSubmissionFileSource: probe.importSourceMaterialize } as never,
  );
  probe.submissionIntentCreate = vi.spyOn(intents, "create");

  const identity = {
    resolvePrincipal: vi.fn().mockResolvedValue(authenticatedPrincipal),
  };
  const config = {
    get: vi.fn((key: string) => {
      if (key === "WORKBENCH_AUTH_MODE") return "development";
      if (key === "NODE_ENV") return "test";
      return undefined;
    }),
  };
  const guard = new WorkbenchAuthGuard(config as never, identity as never);

  class SubmissionIntentHttpModule {}
  Module({
    controllers: [SubmissionIntentsController],
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: IdentityService, useValue: identity },
      { provide: SubmissionIntentsService, useValue: intents },
      { provide: WorkbenchAuthGuard, useValue: guard },
    ],
  })(SubmissionIntentHttpModule);

  const app = await NestFactory.create<NestExpressApplication>(SubmissionIntentHttpModule, {
    abortOnError: false,
    logger: false,
  });
  applications.push(app);
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    endpoint(threadId: string) {
      return `${origin}/api/v1/threads/${threadId}/submission-intents`;
    },
    identity,
    probe,
  };
}

function sideEffectProbe() {
  return {
    submissionIntentCreate: vi.fn(),
    access: vi.fn(),
    runStart: vi.fn(),
    runEventAppend: vi.fn(),
    queuePublish: vi.fn(),
    runtimeProvider: vi.fn(),
    workerProviderInvocation: vi.fn(),
    importSourceMaterialize: vi.fn(),
    persistence: {
      transaction: vi.fn(),
      rawRead: vi.fn(),
      rawWrite: vi.fn(),
      submissionIntentRead: vi.fn(),
      submissionIntentWrite: vi.fn(),
      submissionIntentAttachmentWrite: vi.fn(),
      runRead: vi.fn(),
      runWrite: vi.fn(),
      runtimeAttemptRead: vi.fn(),
      runtimeAttemptWrite: vi.fn(),
      artifactVersionRead: vi.fn(),
      artifactVersionWrite: vi.fn(),
      runEventRead: vi.fn(),
      runEventWrite: vi.fn(),
    },
  };
}

function expectNoSideEffects(probe: SideEffectProbe) {
  expect(probe.submissionIntentCreate, "SubmissionIntent service calls").toHaveBeenCalledTimes(0);
  expect(probe.access, "authorization/resource lookup calls").toHaveBeenCalledTimes(0);
  expect(probe.runStart, "Run service calls").toHaveBeenCalledTimes(0);
  expect(probe.runEventAppend, "Run SSE event writes").toHaveBeenCalledTimes(0);
  expect(probe.queuePublish, "queue publishes").toHaveBeenCalledTimes(0);
  expect(probe.runtimeProvider, "runtime provider catalog calls").toHaveBeenCalledTimes(0);
  expect(probe.workerProviderInvocation, "Worker/provider invocations").toHaveBeenCalledTimes(0);
  expect(probe.importSourceMaterialize, "Import Source materializations").toHaveBeenCalledTimes(0);
  for (const [name, operation] of Object.entries(probe.persistence)) {
    expect(operation, `persistence operation ${name}`).toHaveBeenCalledTimes(0);
  }
}

async function postMixed(
  endpoint: string,
  idempotencyKey: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...headers,
    },
    body: JSON.stringify(mixedRequest),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.json() as Record<string, unknown>,
  };
}

function publicProblem(problem: Record<string, unknown>) {
  return {
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    code: problem.code,
  };
}

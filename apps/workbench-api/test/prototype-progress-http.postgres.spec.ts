import 'reflect-metadata';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { startRunRequestSchema, type RunEvent } from '@workbench/workbench-contracts';
import { PrismaClient } from '@workbench/workbench-db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRunEventStream } from '../../web/lib/workbench/run/stream.js';
import { ProblemDetailsFilter } from '../src/common/problem-details.filter.js';
import { AccessService } from '../src/modules/access/access.service.js';
import { DesignPresetsService } from '../src/modules/design-presets/design-presets.service.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { OidcJwtStrategy } from '../src/modules/identity/oidc-jwt.strategy.js';
import { WorkbenchAuthGuard } from '../src/modules/identity/workbench-auth.guard.js';
import { PrototypeV2Controller } from '../src/modules/prototypes/prototype-v2.controller.js';
import { PrototypeV2Service } from '../src/modules/prototypes/prototype-v2.service.js';
import { RunEventStore } from '../src/modules/runs/run-event.store.js';
import { RunsController } from '../src/modules/runs/runs.controller.js';
import { RunsService } from '../src/modules/runs/runs.service.js';
import { seedFixture } from './fixtures/knowledge-retrieval.js';
import { requirementFlow } from './fixtures/requirement-flow.js';

const databaseUrl = process.env.WORKBENCH_REQUIREMENTS_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)('Confirmed prototype progress over OIDC HTTP and PostgreSQL', () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const store = new RunEventStore();
  let app: NestExpressApplication, jwks: Server, origin: string;
  let progressPath: string, eventsPath: string, otherProjectPath: string, runId: string, threadId: string;
  let viewerToken: string, outsiderToken: string;

  beforeAll(async () => {
    const f = await db.$transaction(tx => seedFixture(tx), { timeout: 60_000 });
    const owner = await db.principal.findUniqueOrThrow({ where: { id: f.ownerId } });
    const outsider = await db.principal.findUniqueOrThrow({ where: { id: f.outsiderId } });
    const viewer = await db.principal.create({ data: { issuer: owner.issuer, subject: randomUUID() } });
    await db.workspaceMember.create({ data: { workspaceId: f.workspaceId, principalId: viewer.id, role: 'member' } });
    await db.projectMember.create({ data: { projectId: f.projectId, workspaceId: f.workspaceId, principalId: viewer.id, role: 'viewer' } });

    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = randomUUID();
    jwks = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
    })));
    await new Promise<void>(resolve => jwks.listen(0, '127.0.0.1', resolve));
    const address = jwks.address();
    if (!address || typeof address === 'string') throw Error('Expected a local JWKS port');
    const config = new ConfigService({
      WORKBENCH_AUTH_MODE: 'oidc', OIDC_ISSUER: owner.issuer, OIDC_AUDIENCE: 'workbench',
      OIDC_JWKS_URL: `http://127.0.0.1:${address.port}/jwks`,
    });
    function token(subject: string) {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const header = encode({ alg: 'RS256', kid, typ: 'JWT' });
      const claims = encode({ sub: subject, iss: owner.issuer, aud: 'workbench', exp: Math.floor(Date.now() / 1000) + 300 });
      const payload = header + '.' + claims;
      return payload + '.' + sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url');
    }
    viewerToken = token(viewer.subject);
    outsiderToken = token(outsider.subject);
    const runs = new RunsService(db as never, new AccessService(db as never), store,
      { sendInTransaction: vi.fn() } as never, { assertAvailable: vi.fn() } as never, new DesignPresetsService());
    const workflows = { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() };
    const prototypes = new PrototypeV2Service(db as never, workflows, config, {} as never, runs);
    const flow = requirementFlow(db, runs, prototypes, f.ownerId, f.projectId);
    const { plan, run } = await flow.create(startRunRequestSchema.parse({
      prompt: 'Add one filter to the existing list', modelId: 'deepseek-flash', workflow: 'generate',
      targetSurface: 'web', designStyle: { kind: 'automatic' }, requestedArtifactKinds: ['prototype'],
    }));
    runId = run.id;
    threadId = run.threadId;
    const progress = (projectId: string) => `/projects/${projectId}/prototype-v2/plans/${plan!.id}/progress`;
    progressPath = progress(f.projectId);
    otherProjectPath = progress(f.outsiderProjectId);
    eventsPath = `/runs/${runId}/events`;

    // Confirmation already dispatched the test project's only command. A
    // read-only fixture must not poll commands owned by concurrent test suites.
    vi.spyOn(prototypes, 'onModuleInit').mockImplementation(() => {});
    class ProgressModule {}
    Module({
      controllers: [PrototypeV2Controller, RunsController],
      providers: [WorkbenchAuthGuard, OidcJwtStrategy, { provide: IdentityService, useValue: new IdentityService(db as never) },
        { provide: ConfigService, useValue: config }, { provide: RunsService, useValue: runs },
        { provide: PrototypeV2Service, useValue: prototypes }],
    })(ProgressModule);
    app = await NestFactory.create<NestExpressApplication>(ProgressModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl() + '/api/v1';
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (jwks) await new Promise<void>(resolve => jwks.close(() => resolve()));
    await db.$disconnect();
  });

  function get(path: string, token?: string) {
    return fetch(origin + path, { headers: token ? { authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(5000) });
  }

  it('denies anonymous progress and events, isolates projects and permits a signed viewer', async () => {
    for (const [path, token, status] of [
      [progressPath, undefined, 401], [eventsPath, undefined, 401],
      [progressPath, outsiderToken, 403], [eventsPath, outsiderToken, 404],
      [otherProjectPath, outsiderToken, 404],
    ] as const) {
      const response = await get(path, token);
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      const problem = await response.json();
      expect(problem.status).toBe(status);
      expect(problem).not.toHaveProperty('events');
      expect(problem).not.toHaveProperty('run');
    }
    const response = await get(progressPath, viewerToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ run: { id: runId } });
  });

  it('resumes the browser stream from the authoritative snapshot after an HTTP request is aborted', async () => {
    const snapshot = async () => {
      const response = await get(progressPath, viewerToken);
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await snapshot();
    const stop = new AbortController();
    const started = await db.$transaction(async tx => {
      await tx.run.update({ where: { id: runId }, data: { status: 'running', attempt: 1 } });
      return store.append(tx, runId, 'run.started', { attempt: 1 });
    });
    const received: RunEvent[] = [];
    const stream = (cursor: number, signal: AbortSignal, onEvent: (event: RunEvent) => void) => readRunEventStream({
      baseUrl: origin, runId, afterSequence: cursor, signal, onEvent,
      fetch: async request => {
        expect(new URL(request.url).searchParams.get('afterSequence')).toBe(String(cursor));
        expect(request.headers.get('last-event-id')).toBe(String(cursor));
        const headers = new Headers(request.headers);
        headers.set('authorization', 'Bearer ' + viewerToken);
        const response = await fetch(new Request(request, { headers }));
        expect(response.headers.get('cache-control')).toContain('private');
        expect(response.headers.get('cache-control')).toContain('no-store');
        return response;
      },
    });
    await expect(stream(first.run.lastEventSequence, AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]), event => {
      received.push(event);
      stop.abort();
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toEqual([started]);

    const missed = await db.$transaction(tx => store.append(tx, runId, 'run.generation.stage.changed', { attempt: 1, stage: 'generating-ui' }));
    const recovered = await snapshot();
    expect(recovered.run).toMatchObject({ id: runId, attempt: 1, lastEventSequence: missed.sequence });
    expect(recovered.events).toContainEqual(missed);
    const failure = { code: 'TEST_RUNTIME_STOPPED', message: 'Stopped by the test runtime', retryable: false };
    const terminal = await db.$transaction(async tx => {
      await tx.run.update({ where: { id: runId }, data: {
        status: 'failed', errorCode: failure.code, errorDetail: failure.message, errorRetryable: false, finishedAt: new Date(),
      } });
      return store.append(tx, runId, 'run.failed', failure);
    });
    const replay = await stream(recovered.run.lastEventSequence, AbortSignal.timeout(5000), event => received.push(event));
    expect(received).toEqual([started, terminal]);
    expect(replay).toMatchObject({ lastSequence: terminal.sequence, terminalEvent: terminal });
    expect(await db.run.count({ where: { threadId } })).toBe(1);
  }, 20_000);
});

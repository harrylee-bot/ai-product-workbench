import { randomUUID, createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "@workbench/workbench-db";
import {
  knowledgeToolResponseSchema,
  startRunRequestSchema,
  type RuntimeArtifactDraft,
  type RuntimeResult,
} from "@workbench/workbench-contracts";
import { prdDocumentV3Example } from "@workbench/workbench-contracts/test-fixtures";
import { verifyKnowledgeToolGrant } from "@workbench/workbench-knowledge";
import { buildFrozenPrototypeHtml } from "../../workbench-build-worker/src/index.js";
import { prototypeDocumentFixture } from "../../../packages/workbench-contracts/test/prototype-fixture.js";
import { AccessService } from "../../workbench-api/src/modules/access/access.service.js";
import { RunsService } from "../../workbench-api/src/modules/runs/runs.service.js";
import { RunEventStore as ApiRunEventStore } from "../../workbench-api/src/modules/runs/run-event.store.js";
import { DesignPresetsService } from "../../workbench-api/src/modules/design-presets/design-presets.service.js";
import { PrototypeV2Service } from "../../workbench-api/src/modules/prototypes/prototype-v2.service.js";
import { ArtifactsService } from "../../workbench-api/src/modules/artifacts/artifacts.service.js";
import { KnowledgeRetrievalService } from "../../workbench-api/src/modules/knowledge/knowledge-retrieval.service.js";
import { PrismaKnowledgeRetrievalStore } from "../../workbench-api/src/modules/knowledge/prisma-knowledge-retrieval.store.js";
import { KnowledgeToolLedgerService } from "../../workbench-api/src/modules/knowledge/knowledge-tool-ledger.service.js";
import { seedFixture, integrationSegmenter } from "../../workbench-api/test/fixtures/knowledge-retrieval.js";
import { requirementFlow } from "../../workbench-api/test/fixtures/requirement-flow.js";
import { RunProcessor } from "../src/runs/run-processor.js";
import { prototypeScreenProjectionChecksum } from "../src/runs/prototype-patch-applier.js";
import { PrismaKnowledgeToolGrantIssuer } from "../src/runtime/knowledge-tool-grant.service.js";
import {
  preparePrototypeRuntime,
  PrototypeRuntimeBridge,
} from "../src/prototypes/prototype-runtime-bridge.js";
import {
  pinGeneratedPrototypeDraft,
  readPrototypeDraft,
  recordPrototypeBuild,
  commitPrototypeDraft,
} from "../src/prototypes/prototype-draft.js";
import { PrototypeArtifactStorage } from "../src/prototypes/prototype-artifact-storage.js";
import type { RuntimeExecution, RuntimeExecutionObserver, RuntimePort } from "../src/runtime/runtime.port.js";

const url = process.env.WORKBENCH_REQUIREMENTS_OUTPUT_TEST_DATABASE_URL;
const secret = Buffer.alloc(32, 47);
const modes: [("prd" | "prototype")[], boolean][] = [];
for (const linked of [false, true])
  for (const kinds of [["prd"], ["prototype"], ["prd", "prototype"]] as ("prd" | "prototype")[][])
    modes.push([kinds, linked]);

// Actual confirmation/Worker/publication/HTML build/Chromium. Model and workflow
// dispatch are controlled ports; S3 transport stores real immutable bytes in memory.
(url ? describe : describe.skip)("Confirmed output operations through PostgreSQL and actual Chromium", () => {
  let db: PrismaClient;
  const services: PrototypeV2Service[] = [];
  beforeAll(() => {
    db = new PrismaClient({ datasourceUrl: url! });
  });
  afterAll(async () => {
    for (const service of services) service.onModuleDestroy();
    await db?.$disconnect();
  });
  async function fixture() {
    const f = await db.$transaction((tx) => seedFixture(tx), { timeout: 60000 });
    await db.board.create({ data: { projectId: f.projectId, viewport: { x: 0, y: 0, zoom: 1 } } });
    const access = new AccessService(db as never);
    const runs = new RunsService(
      db as never,
      access,
      new ApiRunEventStore(),
      { sendInTransaction: vi.fn() } as never,
      { assertAvailable: vi.fn() } as never,
      new DesignPresetsService(),
    );
    const api = new PrototypeV2Service(
      db as never,
      { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn() } as never,
      new ConfigService(),
      {} as never,
      runs,
    );
    services.push(api);
    const flow = requirementFlow(db, runs, api, f.ownerId, f.projectId);
    const issuer = new PrismaKnowledgeToolGrantIssuer(db, {
      endpoint: "https://workbench.test/api/v1/runtime/knowledge/retrieve",
      secret,
      maximumTtlSeconds: 3600,
    });
    const request = (kinds: ("prd" | "prototype")[]) =>
      startRunRequestSchema.parse({
        prompt: "在既有活动管理页面显示报名人数，保留其他权限和流程",
        modelId: "deepseek-flash",
        workflow: "generate",
        targetSurface: "web",
        designStyle: { kind: "automatic" },
        sourceIds: [],
        requestedArtifactKinds: kinds,
      });
    return { ...f, access, runs, api, flow, issuer, request };
  }
  async function citations(execution: RuntimeExecution, f: Awaited<ReturnType<typeof fixture>>) {
    const grant = verifyKnowledgeToolGrant(execution.knowledgeTool!.token, secret, {
      maximumTtlSeconds: 3600,
    });
    const ledger = new KnowledgeToolLedgerService(db as never),
      reservation = await ledger.reserve(grant, randomUUID(), "产品 工作台 用户 规则");
    if (reservation.kind !== "reserved") throw Error("EXPECTED_RESERVATION");
    const retrieval = new KnowledgeRetrievalService(
      f.access,
      new PrismaKnowledgeRetrievalStore(db as never),
      {
        segmenter: integrationSegmenter,
        queryEmbedding: { embedQuery: async () => [1, 0, 0] },
        reranker: {
          identity: { id: "integration/reranker", revision: "commit-reranker-r1" },
          rerank: async ({ candidates }) =>
            candidates.map((item, index) => ({ chunkId: item.chunkId, score: 1 - index / 10 })),
        },
      },
    );
    const result = await retrieval.retrieve({
      principalId: grant.principalId,
      projectId: grant.projectId,
      releaseId: grant.releaseId,
      query: "产品 工作台 用户 规则",
      mode: "hybrid",
      routeScope: "production",
    });
    const response = await ledger.commit(
      grant,
      reservation.reservation,
      knowledgeToolResponseSchema.parse({
        protocol: "workbench.knowledge-retrieval-result.v1",
        evidence: result.evidence,
        items: result.items.map((item) => ({
          rank: item.rank,
          rrfScore: item.rrfScore,
          rerankerScore: item.rerankerScore,
          citation: {
            id: item.citation.id,
            documentId: item.citation.documentId,
            chunkId: item.citation.chunkId,
            sourcePath: item.citation.sourcePath,
            title: item.citation.title,
            quote: item.citation.quote,
            locator: {
              heading: item.citation.locator.headingPath.join(" / ") || null,
              startLine: null,
              endLine: null,
            },
          },
        })),
      }),
    );
    return response.items.map((item) => item.citation);
  }
  function runtime(
    f: Awaited<ReturnType<typeof fixture>>,
    omit?: "prd" | "prototype",
    crash = false,
  ): RuntimePort {
    return {
      adapter: "deerflow",
      createThread: async (metadata) => ({
        externalThreadId: `thread-${metadata.workbenchThreadId}`,
        metadata,
      }),
      cancel: async () => ({ disposition: "not_found", externalRunId: null, externalStatus: null }),
      execute: async (execution, observer) => {
        await observer.onSubmissionStarted();
        await observer.onExternalRunCreated(`provider-${execution.runId}`);
        if (crash) throw Error("CONTROLLED_PROVIDER_FAILURE");
        const retrieved = await citations(execution, f),
          artifacts: RuntimeArtifactDraft[] = [];
        for (const [index, item] of execution.request.outputOperations!.entries()) {
          if (item.kind === omit) continue;
          let content: unknown;
          if (item.operation.kind === "revise") {
            const target = item.operation.target,
              source = execution.artifactTargets.find(
                (row) => row.artifactVersionId === target.artifactVersionId,
              )!;
            if (source.content.mode !== "inline") throw Error("EXPECTED_INLINE_TARGET");
            content = structuredClone(source.content.value);
            if (item.kind === "prd") {
              const prd = content as typeof prdDocumentV3Example;
              prd.revision.number += 1;
              prd.revision.summary = "在原功能中显示报名人数";
            } else {
              const prototype = content as ReturnType<typeof prototypeDocumentFixture>;
              prototype.revision += 1;
              prototype.title = "报名人数修改";
            }
          } else if (item.kind === "prd")
            content = {
              ...structuredClone(prdDocumentV3Example),
              documentId: `prd-${execution.runId}`,
              citations: retrieved,
            };
          else content = { ...prototypeDocumentFixture(), documentId: `prototype-${execution.runId}` };
          const artifact = {
            kind: item.kind,
            schemaVersion: item.kind === "prd" ? 3 : 1,
            title: item.kind === "prd" ? "业务需求说明书" : "活动管理原型",
            operation: item.operation,
            content,
            citations: retrieved,
          } as RuntimeArtifactDraft;
          for (const stage of item.kind === "prd"
            ? ["collecting-prd-context", "structuring-prd", "drafting-prd", "validating-prd"]
            : ["design-system", "mapping-components", "creating-flows", "generating-ui"])
            await observer.onExternalEvent(
              {
                externalRunId: `provider-${execution.runId}`,
                externalEventId: `${index}:${stage}`,
                event: "custom",
                payload: {},
              },
              [{ type: "generation.stage", stage, sourceEventId: `provider:${index}:${stage}` } as never],
            );
          await observer.onExternalEvent(
            {
              externalRunId: `provider-${execution.runId}`,
              externalEventId: `draft-${index}`,
              event: "custom",
              payload: {},
            },
            [
              {
                type: "artifact.draft",
                artifactIndex: index,
                sourceEventId: `provider:draft-${index}`,
                draft: artifact,
                checkpointScreens:
                  artifact.kind === "prototype"
                    ? artifact.content.screens.map(({ id }) => ({
                        screenId: id,
                        revision: 0,
                        checksum: prototypeScreenProjectionChecksum(artifact.content, id, 0),
                      }))
                    : [],
              },
            ],
          );
          artifacts.push(artifact);
        }
        return {
          protocol: "workbench.runtime.result.v1",
          message: "已按确认清单交付",
          artifacts,
        } as RuntimeResult;
      },
    };
  }
  async function deliver(
    f: Awaited<ReturnType<typeof fixture>>,
    created: Awaited<ReturnType<ReturnType<typeof requirementFlow>["create"]>>,
    port = runtime(f),
  ) {
    if (!created.plan) {
      await new RunProcessor(db, port, f.issuer).execute(created.run.id);
      return null;
    }
    const input = await preparePrototypeRuntime(db, {
      projectId: f.projectId,
      planId: created.plan.id,
      createdById: f.ownerId,
    });
    const bridge = new PrototypeRuntimeBridge(db, port, f.issuer),
      generated = await bridge.generate(input, new AbortController().signal, vi.fn());
    const pinned = await pinGeneratedPrototypeDraft(db, input, generated),
      draft = await readPrototypeDraft(db, pinned);
    const built = await buildFrozenPrototypeHtml(input.revisionId, generated.title, draft.pages, {
      sourceDocument: draft.sourceDocument,
      chromiumExecutablePath: process.env.WORKBENCH_EXPORT_CHROMIUM_PATH,
    });
    const objects = new Map<string, { body: Uint8Array; sha256: string; mediaType: string }>();
    const storage = new PrototypeArtifactStorage({
      bucket: "fixture",
      prefix: "immutable",
      client: {
        send: async (command: { input: Record<string, any> }) => {
          const x = command.input;
          if (x.Body) {
            if (objects.has(x.Key)) throw { $metadata: { httpStatusCode: 412 } };
            objects.set(x.Key, {
              body: Uint8Array.from(x.Body),
              sha256: x.Metadata.sha256,
              mediaType: x.ContentType,
            });
            return {};
          }
          const stored = objects.get(x.Key)!;
          return {
            ContentLength: stored.body.byteLength,
            ContentType: stored.mediaType,
            Metadata: { sha256: stored.sha256 },
            Body: { transformToByteArray: async () => stored.body },
          };
        },
      } as never,
    });
    const identity = await storage.putImmutable(
      {
        key: `${f.projectId}/${input.revisionId}/preview.html`,
        sha256: built.htmlSha256,
        byteSize: built.byteSize,
        mediaType: "text/html; charset=utf-8",
      },
      Buffer.from(built.html),
    );
    await storage.verifyImmutable(identity);
    expect(
      createHash("sha256")
        .update(await storage.readImmutable(identity))
        .digest("hex"),
    ).toBe(built.htmlSha256);
    const recorded = await recordPrototypeBuild(db, pinned, identity);
    await commitPrototypeDraft(db, recorded);
    await commitPrototypeDraft(db, recorded);
    const revision = await db.prototypeRevision.findUniqueOrThrow({ where: { id: input.revisionId } });
    expect(revision).toMatchObject({
      status: "ready",
      sourceArtifactVersionId: generated.sourceArtifactVersionId,
      builtArtifactSha256: built.htmlSha256,
    });
    expect((await db.prototypePlan.findUniqueOrThrow({ where: { id: created.plan.id } })).status).toBe(
      "ready",
    );
    return revision;
  }
  async function base(f: Awaited<ReturnType<typeof fixture>>, linked: boolean) {
    const created = await f.flow.create(f.request(linked ? ["prd", "prototype"] : ["prototype"]));
    const revision = (await deliver(f, created))!;
    const versions = await db.artifactVersion.findMany({
      where: { createdByRunId: created.run.id, status: "ready" },
      include: { artifact: true },
    });
    return {
      created,
      revision,
      prototype: versions.find((row) => row.artifact.kind === "prototype")!,
      prd: versions.find((row) => row.artifact.kind === "prd"),
    };
  }
  it.each(modes)(
    "delivers outputs %j from a source with linked PRD=%s",
    async (kinds, linked) => {
      const f = await fixture(),
        source = await base(f, linked);
      const created = await f.flow.create(f.request(kinds), {
        kind: "revision",
        revisionId: source.revision.id,
        feedbackIds: [],
        anchor: null,
      });
      expect(created.request.outputOperations?.map((item) => [item.kind, item.operation.kind])).toEqual(
        kinds.map((kind) => [kind, kind === "prototype" || linked ? "revise" : "create"]),
      );
      const confirmation = await db.requirementConfirmation.findUniqueOrThrow({
        where: { id: created.request.requirementConfirmationId! },
      });
      expect((confirmation.baseline as any).analysisContext.request.outputOperations).toEqual(
        created.request.outputOperations,
      );
      expect((confirmation.generationRequest as any).outputOperations).toEqual(
        created.request.outputOperations,
      );
      const revision = await deliver(f, created);
      expect((await db.run.findUniqueOrThrow({ where: { id: created.run.id } })).status).toBe("succeeded");
      const produced = await db.artifactVersion.findMany({
        where: { createdByRunId: created.run.id, status: "ready" },
        include: { artifact: true },
        orderBy: { runtimeDraftIndex: "asc" },
      });
      expect(produced.map((row) => row.artifact.kind)).toEqual(kinds);
      expect(
        await db.artifactVersion.findUniqueOrThrow({ where: { id: source.prototype.id } }),
      ).toMatchObject({ checksum: source.prototype.checksum, content: source.prototype.content });
      const nextPrototype = produced.find((row) => row.artifact.kind === "prototype"),
        nextPrd = produced.find((row) => row.artifact.kind === "prd");
      expect(
        (await db.artifact.findUniqueOrThrow({ where: { id: source.prototype.artifactId } }))
          .currentVersionId,
      ).toBe(nextPrototype?.id ?? source.prototype.id);
      if (nextPrototype) {
        expect(nextPrototype.artifactId).toBe(source.prototype.artifactId);
        expect(nextPrototype.version).toBe(source.prototype.version + 1);
        expect(nextPrototype.sourcePrdVersionId).toBe(nextPrd?.id ?? source.prd?.id ?? null);
        expect(revision!.sourceRevisionId).toBe(source.revision.id);
        expect(revision!.sourceArtifactVersionId).toBe(nextPrototype.id);
        const relations = await f.api.revisionRelations(
          { id: f.ownerId } as never,
          f.projectId,
          revision!.id,
        );
        expect(relations.sourcePrd?.artifactVersionId ?? null).toBe(nextPrd?.id ?? source.prd?.id ?? null);
      } else expect(revision).toBeNull();
      if (source.prd)
        expect(
          (await db.artifact.findUniqueOrThrow({ where: { id: source.prd.artifactId } })).currentVersionId,
        ).toBe(nextPrd?.id ?? source.prd.id);
      if (nextPrd && source.prd) {
        expect(nextPrd.artifactId).toBe(source.prd.artifactId);
        expect((nextPrd.content as any).documentId).toBe((source.prd.content as any).documentId);
      }
      if (nextPrd && nextPrototype) {
        const relations = await new ArtifactsService(db as never, {} as never).relations(
          f.ownerId,
          nextPrd.artifactId,
          nextPrd.id,
        );
        expect(relations.derivedPrototypes.some((item) => item.artifactVersionId === nextPrototype.id)).toBe(
          true,
        );
      }
    },
    120000,
  );
  it.each(["prd", "prototype"] as const)(
    "rejects joint delivery missing %s and never promotes partial artifacts",
    async (missing) => {
      const f = await fixture(),
        source = await base(f, false),
        created = await f.flow.create(f.request(["prd", "prototype"]), {
          kind: "revision",
          revisionId: source.revision.id,
          feedbackIds: [],
          anchor: null,
        });
      const input = await preparePrototypeRuntime(db, {
        projectId: f.projectId,
        planId: created.plan!.id,
        createdById: f.ownerId,
      });
      await expect(
        new PrototypeRuntimeBridge(db, runtime(f, missing), f.issuer).generate(
          input,
          new AbortController().signal,
          vi.fn(),
        ),
      ).rejects.toThrow();
      expect((await db.run.findUniqueOrThrow({ where: { id: created.run.id } })).status).toBe("failed");
      expect(
        await db.artifactVersion.count({ where: { createdByRunId: created.run.id, status: "ready" } }),
      ).toBe(0);
      expect(
        (await db.artifact.findUniqueOrThrow({ where: { id: source.prototype.artifactId } }))
          .currentVersionId,
      ).toBe(source.prototype.id);
    },
    120000,
  );
  it("retries the same frozen joint operations through Plan and completes an actual new version build", async () => {
    const f = await fixture(),
      source = await base(f, true),
      created = await f.flow.create(f.request(["prd", "prototype"]), {
        kind: "revision",
        revisionId: source.revision.id,
        feedbackIds: [],
        anchor: null,
      });
    const input = await preparePrototypeRuntime(db, {
      projectId: f.projectId,
      planId: created.plan!.id,
      createdById: f.ownerId,
    });
    await expect(
      new PrototypeRuntimeBridge(db, runtime(f, undefined, true), f.issuer).generate(
        input,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow();
    // The workflow failure callback marks the Plan; provider/Run failure above is real.
    const failed = await db.prototypePlan.update({
      where: { id: created.plan!.id },
      data: {
        status: "failed",
        failureCode: "PROTOTYPE_RUNTIME_FAILED",
        failureDetail: "Controlled provider failure",
        revision: { increment: 1 },
      },
    });
    const retry = await f.api.retryPlan(
      { id: f.ownerId } as never,
      f.projectId,
      failed.id,
      "retry-outputs",
      `"${failed.revision}"`,
      {},
    );
    expect(
      (
        await f.api.retryPlan(
          { id: f.ownerId } as never,
          f.projectId,
          failed.id,
          "retry-outputs",
          `"${failed.revision}"`,
          {},
        )
      ).id,
    ).toBe(retry.id);
    const row = await db.prototypePlan.findUniqueOrThrow({ where: { id: retry.id } }),
      run = await db.run.findUniqueOrThrow({ where: { id: row.runtimeRunId! } });
    expect(run.retryOfRunId).toBe(created.run.id);
    expect(run.request).toEqual(created.request);
    expect(run.knowledgeReleaseId).toBe(created.run.knowledgeReleaseId);
    await deliver(f, { ...created, plan: retry, run, request: startRunRequestSchema.parse(run.request) });
    const result = await db.artifactVersion.findMany({
      where: { createdByRunId: run.id, status: "ready" },
      include: { artifact: true },
    });
    expect(result).toHaveLength(2);
    expect(result.find((row) => row.artifact.kind === "prototype")?.sourcePrdVersionId).toBe(
      result.find((row) => row.artifact.kind === "prd")?.id,
    );
  }, 120000);
  it("rejects confirmation if the linked PRD moves after discussion without changing the selected source", async () => {
    const f = await fixture(),
      source = await base(f, true);
    const discussion = await f.flow.prepare(f.request(["prd", "prototype"]), {
        kind: "revision",
        revisionId: source.revision.id,
        feedbackIds: [],
        anchor: null,
      }),
      analysis = await discussion.analyze();
    const next = await db.artifactVersion.create({
      data: {
        projectId: f.projectId,
        artifactId: source.prd!.artifactId,
        version: 2,
        schemaVersion: 3,
        status: "ready",
        content: source.prd!.content as Prisma.InputJsonValue,
        checksum: source.prd!.checksum,
        citations: source.prd!.citations as Prisma.InputJsonValue,
      },
    });
    await db.artifact.update({ where: { id: source.prd!.artifactId }, data: { currentVersionId: next.id } });
    await expect(analysis.confirm()).rejects.toMatchObject({
      status: 409,
      response: { code: "REQUIREMENT_SOURCE_CHANGED" },
    });
    expect(await db.run.count({ where: { threadId: discussion.session.threadId } })).toBe(0);
  }, 120000);
  it("retries PRD-only creation from the frozen read-only Prototype even after its current version advances", async () => {
    const f = await fixture(),
      source = await base(f, false);
    const created = await f.flow.create(f.request(["prd"]), {
      kind: "revision",
      revisionId: source.revision.id,
      feedbackIds: [],
      anchor: null,
    });
    await expect(
      new RunProcessor(db, runtime(f, undefined, true), f.issuer).execute(created.run.id),
    ).rejects.toThrow("CONTROLLED_PROVIDER_FAILURE");
    expect((await db.run.findUniqueOrThrow({ where: { id: created.run.id } })).status).toBe("failed");
    const next = await db.artifactVersion.create({
      data: {
        projectId: f.projectId,
        artifactId: source.prototype.artifactId,
        version: 2,
        schemaVersion: 1,
        status: "ready",
        content: source.prototype.content as Prisma.InputJsonValue,
        checksum: source.prototype.checksum,
        citations: source.prototype.citations as Prisma.InputJsonValue,
      },
    });
    await db.artifact.update({
      where: { id: source.prototype.artifactId },
      data: { currentVersionId: next.id },
    });
    const retry = await f.runs.retry(f.ownerId, created.run.id, "retry-prd-only"),
      run = await db.run.findUniqueOrThrow({ where: { id: retry.id } });
    expect(run.request).toEqual(created.request);
    expect(run.retryOfRunId).toBe(created.run.id);
    await deliver(f, { ...created, run });
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("succeeded");
    expect(
      await db.artifactVersion.count({
        where: { createdByRunId: run.id, status: "ready", artifact: { kind: "prd" } },
      }),
    ).toBe(1);
    expect(
      (await db.artifact.findUniqueOrThrow({ where: { id: source.prototype.artifactId } })).currentVersionId,
    ).toBe(next.id);
  }, 120000);
  it("rebuilds a successful joint Run through Plan retry without a second model execution or new artifact versions", async () => {
    const f = await fixture(),
      source = await base(f, true);
    const created = await f.flow.create(f.request(["prd", "prototype"]), {
      kind: "revision",
      revisionId: source.revision.id,
      feedbackIds: [],
      anchor: null,
    });
    const input = await preparePrototypeRuntime(db, {
      projectId: f.projectId,
      planId: created.plan!.id,
      createdById: f.ownerId,
    });
    const generated = await new PrototypeRuntimeBridge(db, runtime(f), f.issuer).generate(
      input,
      new AbortController().signal,
      vi.fn(),
    );
    await pinGeneratedPrototypeDraft(db, input, generated);
    // A failed external build follows a successful real Worker publication.
    const failed = await db.prototypePlan.update({
      where: { id: created.plan!.id },
      data: {
        status: "failed",
        failureCode: "PROTOTYPE_BUILD_FAILED",
        failureDetail: "Controlled build outage before persistence",
        revision: { increment: 1 },
      },
    });
    const retry = await f.api.retryPlan(
      { id: f.ownerId } as never,
      f.projectId,
      failed.id,
      "retry-build",
      `"${failed.revision}"`,
      {},
    );
    const plan = await db.prototypePlan.findUniqueOrThrow({ where: { id: retry.id } });
    expect(plan.reusedRunId).toBe(created.run.id);
    expect(plan.runtimeRunId).toBeNull();
    const port = runtime(f, undefined, true),
      execute = vi.spyOn(port, "execute");
    const revision = await deliver(f, { ...created, plan: retry }, port);
    expect(execute).not.toHaveBeenCalled();
    expect(revision!.sourceArtifactVersionId).toBe(generated.sourceArtifactVersionId);
    expect(
      await db.artifactVersion.count({ where: { createdByRunId: created.run.id, status: "ready" } }),
    ).toBe(2);
    expect(
      (await f.api.revisionRelations({ id: f.ownerId } as never, f.projectId, revision!.id)).sourcePrd
        ?.artifactVersionId,
    ).toBe(
      (await db.artifactVersion.findUniqueOrThrow({ where: { id: generated.sourceArtifactVersionId! } }))
        .sourcePrdVersionId,
    );
  }, 120000);
});

import { createHash } from "node:crypto";
import type { Response } from "express";
import {
  canonicalJson,
  createArtifactVersionRequestSchema,
  type CreateArtifactVersionRequest,
  type PrdDocument,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";
import { hashRequest } from "../src/common/idempotency.js";
import { ArtifactsController } from "../src/modules/artifacts/artifacts.controller.js";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service.js";

const createdAt = new Date("2026-07-14T01:00:00.000Z");
const idempotencyKey = "artifact-version:key-1";
const citation = {
  id: "citation.1",
  documentId: "knowledge-document-1",
  chunkId: "knowledge-chunk-1",
  sourcePath: "knowledge-vault/source.md",
  title: "Source",
  quote: "Evidence",
  locator: { heading: "Context", startLine: 1, endLine: 2 },
};
const imageAsset = {
  id: "hero-image",
  kind: "image" as const,
  name: "Hero",
  blobId: "blob_1",
  mediaType: "image/png",
  byteSize: 128,
  sha256: "a".repeat(64),
  width: 320,
  height: 180,
};

function prototypeDocument(revision: number): PrototypeDocument {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const nodeBase = (id: string, parentId: string | null) => ({
    id,
    screenId: "screen-home",
    parentId,
    name: id,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: null,
      stroke: null,
      radii: {
        topLeft: literal(0),
        topRight: literal(0),
        bottomRight: literal(0),
        bottomLeft: literal(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
  });
  return {
    protocol: "workbench.prototype.v1",
    documentId: "prototype-document",
    title: "Prototype",
    revision,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "frame-root",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [
      {
        ...nodeBase("frame-root", null),
        kind: "frame",
        childIds: ["image-hero"],
        clipContent: true,
      },
      {
        ...nodeBase("image-hero", "frame-root"),
        kind: "image",
        assetId: imageAsset.id,
        fit: "cover",
        alt: "Hero",
      },
    ],
    tokens: [],
    assets: [imageAsset],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

const request: CreateArtifactVersionRequest = {
  kind: "prototype",
  baseArtifactVersionId: "version_1",
  document: prototypeDocument(2),
};

function prdDocument(revision: number, title = "PRD"): PrdDocument {
  const text = (value: string) => [{ type: "text" as const, text: value, marks: [] }];
  return {
    protocol: "workbench.prd.v1",
    documentId: "prd-document",
    title,
    revision: {
      number: revision,
      status: "draft",
      summary: "Manual edit",
      changedAt: "2026-07-14T01:00:00.000Z",
      changedById: null,
    },
    assumptions: [],
    citations: [],
    sections: {
      executiveSummary: { title: "Summary", blocks: [{ id: "summary", type: "paragraph", content: text("Summary") }] },
      problem: { title: "Problem", blocks: [{ id: "problem", type: "paragraph", content: text("Problem") }] },
      goals: { title: "Goals", blocks: [{ id: "goal", type: "goal", title: "Goal", description: text("Goal"), successMetric: "Metric", priority: "primary" }] },
      targetUsers: { title: "Users", blocks: [{ id: "persona", type: "persona", name: "User", description: text("User"), needs: ["Need"], painPoints: ["Pain"] }] },
      scope: { title: "Scope", blocks: [{ id: "scope", type: "bulletList", items: [{ id: "scope-item", content: text("Scope") }] }] },
      requirements: { title: "Requirements", blocks: [{ id: "requirement", type: "requirement", title: "Requirement", description: text("Requirement"), priority: "must", goalIds: ["goal"], acceptanceCriterionIds: ["criterion"] }] },
      userFlows: { title: "Flows", blocks: [{ id: "flow", type: "flow", title: "Flow", actor: "User", trigger: "Start", steps: [{ id: "step", text: "Step", requirementIds: ["requirement"] }], outcome: "Done" }] },
      acceptanceCriteria: { title: "Acceptance", blocks: [{ id: "criterion", type: "acceptanceCriterion", requirementIds: ["requirement"], given: text("Given"), when: text("When"), then: text("Then") }] },
      risksAndDependencies: { title: "Risks", blocks: [{ id: "risk", type: "risk", description: text("Risk"), likelihood: "low", impact: "low", mitigation: text("Mitigate") }] },
    },
  };
}
const checksum = createHash("sha256").update(canonicalJson(request.document)).digest("hex");
const readyVersion = {
  id: "version_2",
  artifactId: "artifact_1",
  version: 2,
  schemaVersion: 1,
  status: "ready" as const,
  content: request.document,
  contentBlobId: null,
  checksum,
  citations: [citation],
  createdByRunId: null,
  knowledgeReleaseId: "knowledge_1",
  createdAt,
  artifact: { kind: "prototype" as const },
};

function receipt(resultVersion = readyVersion) {
  return {
    artifactId: "artifact_1",
    baseArtifactVersionId: "version_1",
    resultArtifactVersionId: resultVersion.id,
    expectedArtifactRevision: 5,
    resultArtifactRevision: 6,
    createdById: "principal_1",
    idempotencyKey,
    requestHash: hashRequest(request),
    resultVersion,
  };
}

function createHarness(options: {
  artifactKind?: string;
  artifactRevision?: number;
  currentVersionId?: string | null;
  initialReceipt?: ReturnType<typeof receipt> | null;
  transactionReceipt?: ReturnType<typeof receipt> | null;
} = {}) {
  let persistedReceipt = options.initialReceipt ?? null;
  const baseVersion = {
    id: "version_1",
    artifactId: "artifact_1",
    projectId: "project_1",
    version: 1,
    schemaVersion: 1,
    status: "ready",
    content: prototypeDocument(1),
    contentBlobId: null,
    citations: [citation],
    knowledgeReleaseId: "knowledge_1",
    assets: [{
      artifactVersionId: "version_1",
      artifactId: "artifact_1",
      projectId: "project_1",
      assetId: imageAsset.id,
      kind: imageAsset.kind,
      blobId: imageAsset.blobId,
      mediaType: imageAsset.mediaType,
      byteSize: BigInt(imageAsset.byteSize),
      sha256: imageAsset.sha256,
      metadata: imageAsset,
    }],
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{
      id: "artifact_1",
      projectId: "project_1",
      kind: options.artifactKind ?? "prototype",
      revision: options.artifactRevision ?? 5,
      currentVersionId: options.currentVersionId === undefined ? "version_1" : options.currentVersionId,
    }]),
    projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
    artifactVersionEditReceipt: {
      findUnique: vi.fn().mockImplementation(async () => options.transactionReceipt ?? persistedReceipt),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        persistedReceipt = { ...data, resultVersion: readyVersion } as ReturnType<typeof receipt>;
        return data;
      }),
    },
    artifactVersion: {
      findUnique: vi.fn().mockResolvedValue(baseVersion),
      findFirst: vi.fn().mockResolvedValue({ version: 1 }),
      create: vi.fn().mockResolvedValue({ id: "version_2" }),
      update: vi.fn().mockResolvedValue(readyVersion),
    },
    artifactVersionAsset: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    artifact: { update: vi.fn().mockResolvedValue({ revision: 6 }) },
  };
  const db = {
    artifact: { findFirst: vi.fn().mockResolvedValue({ id: "artifact_1" }) },
    artifactVersionEditReceipt: {
      findUnique: vi.fn().mockImplementation(async () => persistedReceipt),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const service = new ArtifactsService(db as never, {} as never);
  return { db, tx, service };
}

describe("ArtifactVersion user edit command", () => {
  it("publishes an immutable ready version, inherits provenance/assets, and replays a lost response", async () => {
    const { db, tx, service } = createHarness();

    const first = await service.createVersion(
      "principal_1",
      "artifact_1",
      5,
      idempotencyKey,
      request,
    );
    expect(first).toMatchObject({
      artifactRevision: 6,
      detail: {
        artifactVersionId: "version_2",
        kind: "prototype",
        status: "ready",
        content: request.document,
        citations: [citation],
        knowledgeReleaseId: "knowledge_1",
      },
    });
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact_1",
        projectId: "project_1",
        version: 2,
        schemaVersion: 1,
        status: "staging",
        content: request.document,
        checksum,
        citations: [citation],
        createdByRunId: null,
        knowledgeReleaseId: "knowledge_1",
      }),
    });
    expect(tx.artifactVersionAsset.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        artifactVersionId: "version_2",
        assetId: imageAsset.id,
        blobId: imageAsset.blobId,
        metadata: imageAsset,
      })],
    });
    expect(tx.artifactVersion.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "version_2" },
      data: { status: "ready" },
    }));
    expect(tx.artifact.update).toHaveBeenCalledWith({
      where: { id: "artifact_1" },
      data: { currentVersionId: "version_2", revision: { increment: 1 } },
      select: { revision: true },
    });
    expect(tx.artifactVersionEditReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact_1",
        baseArtifactVersionId: "version_1",
        resultArtifactVersionId: "version_2",
        expectedArtifactRevision: 5,
        resultArtifactRevision: 6,
        createdById: "principal_1",
        idempotencyKey,
        requestHash: hashRequest(request),
      }),
    });

    await expect(service.createVersion(
      "principal_1",
      "artifact_1",
      5,
      idempotencyKey,
      request,
    )).resolves.toEqual(first);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.artifactVersion.create).toHaveBeenCalledTimes(1);
  });

  it("returns a concurrent receipt before evaluating a now-stale Artifact revision", async () => {
    const { tx, service } = createHarness({ artifactRevision: 6, transactionReceipt: receipt() });
    await expect(service.createVersion(
      "principal_1", "artifact_1", 5, idempotencyKey, request,
    )).resolves.toMatchObject({ artifactRevision: 6, detail: { artifactVersionId: "version_2" } });
    expect(tx.artifactVersion.create).not.toHaveBeenCalled();
  });

  it("rejects key reuse by another payload or caller", async () => {
    const payload = createHarness({ initialReceipt: receipt() });
    await expect(payload.service.createVersion(
      "principal_1",
      "artifact_1",
      5,
      idempotencyKey,
      { ...request, document: { ...request.document, title: "Different" } },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
    const caller = createHarness({ initialReceipt: receipt() });
    await expect(caller.service.createVersion(
      "principal_2", "artifact_1", 5, idempotencyKey, request,
    )).rejects.toMatchObject({ status: 409 });
    expect(payload.db.$transaction).not.toHaveBeenCalled();
    expect(caller.db.$transaction).not.toHaveBeenCalled();
  });

  it("enforces Artifact CAS, kind, current base, document continuity, and inherited asset pins", async () => {
    const stale = createHarness({ artifactRevision: 6 });
    await expect(stale.service.createVersion(
      "principal_1", "artifact_1", 5, "artifact-version:stale", request,
    )).rejects.toMatchObject({ status: 412 });

    const wrongKind = createHarness({ artifactKind: "data" });
    await expect(wrongKind.service.createVersion(
      "principal_1", "artifact_1", 5, "artifact-version:kind", request,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_KIND_NOT_EDITABLE" }),
    });

    const wrongBase = createHarness({ currentVersionId: "version_other" });
    await expect(wrongBase.service.createVersion(
      "principal_1", "artifact_1", 5, "artifact-version:base", request,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_VERSION_BASE_NOT_CURRENT" }),
    });

    const changedDocumentId = createHarness();
    await expect(changedDocumentId.service.createVersion(
      "principal_1",
      "artifact_1",
      5,
      "artifact-version:document",
      { ...request, document: { ...request.document, documentId: "other-document" } },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_DOCUMENT_ID_MISMATCH" }),
    });

    const changedAssets = createHarness();
    await expect(changedAssets.service.createVersion(
      "principal_1",
      "artifact_1",
      5,
      "artifact-version:assets",
      { ...request, document: { ...request.document, assets: [] } },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_VERSION_ASSET_CONFLICT" }),
    });
  });

  it("validates the complete v1 PRD and Prototype request contracts", () => {
    expect(createArtifactVersionRequestSchema.parse(request)).toEqual(request);
    const prdRequest: CreateArtifactVersionRequest = {
      kind: "prd",
      baseArtifactVersionId: "version_1",
      document: prdDocument(2),
    };
    expect(createArtifactVersionRequestSchema.parse(prdRequest)).toEqual(prdRequest);
    expect(() => createArtifactVersionRequestSchema.parse({ ...prdRequest, document: request.document })).toThrow();
  });

  it("publishes a PRD version while retaining its document identity and citations", async () => {
    const baseDocument = prdDocument(1);
    const prdRequest: CreateArtifactVersionRequest = {
      kind: "prd",
      baseArtifactVersionId: "version_1",
      document: prdDocument(2, "Edited PRD"),
    };
    const ready = {
      id: "version_2",
      artifactId: "artifact_prd",
      version: 2,
      schemaVersion: 1,
      status: "ready" as const,
      content: prdRequest.document,
      contentBlobId: null,
      checksum: createHash("sha256").update(canonicalJson(prdRequest.document)).digest("hex"),
      citations: [],
      createdByRunId: null,
      knowledgeReleaseId: "knowledge_1",
      createdAt,
      artifact: { kind: "prd" as const },
    };
    let receipt: Record<string, unknown> | null = null;
    const baseVersion = {
      id: "version_1",
      artifactId: "artifact_prd",
      projectId: "project_1",
      version: 1,
      schemaVersion: 1,
      status: "ready",
      content: baseDocument,
      contentBlobId: null,
      citations: [],
      knowledgeReleaseId: "knowledge_1",
      assets: [],
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{
        id: "artifact_prd",
        projectId: "project_1",
        kind: "prd",
        revision: 5,
        currentVersionId: "version_1",
      }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      artifactVersionEditReceipt: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where?: { artifactId_idempotencyKey?: { idempotencyKey?: string } } }) => (
          where?.artifactId_idempotencyKey?.idempotencyKey === "prd-version:key-1" ? receipt : null
        )),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          receipt = { ...data, resultVersion: ready };
          return data;
        }),
      },
      artifactVersion: {
        findUnique: vi.fn().mockResolvedValue(baseVersion),
        findFirst: vi.fn().mockResolvedValue({ version: 1 }),
        create: vi.fn().mockResolvedValue({ id: "version_2" }),
        update: vi.fn().mockResolvedValue(ready),
      },
      artifactVersionAsset: { createMany: vi.fn() },
      artifact: { update: vi.fn().mockResolvedValue({ revision: 6 }) },
    };
    const db = {
      artifact: { findFirst: vi.fn().mockResolvedValue({ id: "artifact_prd" }) },
      artifactVersionEditReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ArtifactsService(db as never, {} as never);

    const result = await service.createVersion(
      "principal_1",
      "artifact_prd",
      5,
      "prd-version:key-1",
      prdRequest,
    );
    expect(result).toMatchObject({
      artifactRevision: 6,
      detail: { artifactVersionId: "version_2", kind: "prd", content: prdRequest.document },
    });
    expect(tx.artifactVersionAsset.createMany).not.toHaveBeenCalled();
    expect(tx.artifactVersionEditReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        artifactId: "artifact_prd",
        baseArtifactVersionId: "version_1",
        resultArtifactVersionId: "version_2",
      }),
    });

    await expect(service.createVersion(
      "principal_1",
      "artifact_prd",
      5,
      "prd-version:stale",
      { ...prdRequest, document: prdDocument(1, "Stale") },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ARTIFACT_DOCUMENT_REVISION_CONFLICT" }),
    });
  });
});

describe("ArtifactsController createVersion", () => {
  it("requires both preconditions and returns the first Artifact revision and immutable Location", async () => {
    const artifacts = {
      createVersion: vi.fn().mockResolvedValue({
        detail: {
          artifactVersionId: "version_2",
        },
        artifactRevision: 6,
      }),
    };
    const controller = new ArtifactsController(artifacts as never);
    const response = { setHeader: vi.fn() };

    await expect(controller.createVersion(
      { id: "principal_1" } as never,
      "artifact_1",
      '"5"',
      undefined,
      request,
      response as unknown as Response,
    )).rejects.toMatchObject({ status: 400 });
    expect(artifacts.createVersion).not.toHaveBeenCalled();

    await expect(controller.createVersion(
      { id: "principal_1" } as never,
      "artifact_1",
      '"5"',
      idempotencyKey,
      request,
      response as unknown as Response,
    )).resolves.toEqual({ artifactVersionId: "version_2" });
    expect(artifacts.createVersion).toHaveBeenCalledWith(
      "principal_1", "artifact_1", 5, idempotencyKey, request,
    );
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"6"');
    expect(response.setHeader).toHaveBeenCalledWith(
      "Location",
      "/api/v1/artifacts/artifact_1/versions/version_2",
    );
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});

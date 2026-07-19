import { createHash } from "node:crypto";
import { canonicalJson } from "@workbench/workbench-contracts";
import { Prisma } from "@workbench/workbench-db";
import { DesignSystemImportsService } from "../src/modules/design-systems/design-system-imports.service.js";
import { DesignSystemsService } from "../src/modules/design-systems/design-systems.service.js";

const now = new Date("2026-07-13T00:00:00.000Z");

function documentFixture() {
  return {
    protocol: "workbench.design-system.v1" as const,
    documentId: "design-main",
    title: "Product UI",
    tokens: [{
      id: "token-primary",
      path: "color.primary",
      type: "color" as const,
      value: { kind: "literal" as const, value: "#112233" },
      description: null,
    }],
    assets: [],
    principles: [],
    guidelines: [],
    components: [],
  };
}

function sourceVersion(overrides: Record<string, unknown> = {}) {
  const content = documentFixture();
  return {
    id: "version_source",
    artifactId: "artifact_source",
    projectId: "project_source",
    version: 1,
    schemaVersion: 1,
    status: "ready" as const,
    content,
    contentBlobId: null,
    checksum: createHash("sha256").update(canonicalJson(content)).digest("hex"),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: now,
    artifact: {
      id: "artifact_source",
      projectId: "project_source",
      kind: "design_system" as const,
      title: "Source Design",
      project: {
        id: "project_source",
        workspaceId: "workspace_1",
        status: "active" as const,
      },
    },
    assets: [],
    ...overrides,
  };
}

describe("Design System commands", () => {
  it("creates a ready first-class Design System Artifact with an immutable command receipt", async () => {
    const receipt = {
      id: "creation_1",
      projectId: "project_target",
      artifactId: "artifact_target",
      artifactVersionId: "version_target",
      checksum: "c".repeat(64),
      createdById: "principal_1",
      idempotencyKey: "design:create:12345678",
      requestHash: "d".repeat(64),
      createdAt: now,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_target", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "owner" }) },
      designSystemCreation: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({ ...receipt, ...data })),
      },
      fileAsset: { findMany: vi.fn().mockResolvedValue([]) },
      artifact: {
        create: vi.fn().mockResolvedValue({ id: "artifact_target" }),
        update: vi.fn().mockResolvedValue({}),
      },
      artifactVersion: {
        create: vi.fn().mockResolvedValue({ id: "version_target" }),
        update: vi.fn().mockResolvedValue({}),
      },
      artifactVersionAsset: { createMany: vi.fn() },
    };
    const db = {
      designSystemCreation: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };
    const request = { title: "Product UI", document: documentFixture() };
    receipt.requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    receipt.checksum = createHash("sha256").update(canonicalJson(request.document)).digest("hex");

    const result = await new DesignSystemsService(db as never, access as never).create(
      "principal_1",
      "project_target",
      receipt.idempotencyKey,
      request,
    );

    expect(result).toMatchObject({
      artifactId: "artifact_target",
      artifactVersionId: "version_target",
      checksum: receipt.checksum,
    });
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_target",
        status: "staging",
        schemaVersion: 1,
        content: request.document,
      }),
    });
    expect(tx.artifactVersion.update).toHaveBeenCalledWith({
      where: { id: "version_target" },
      data: { status: "ready" },
    });
    expect(tx.designSystemCreation.create).toHaveBeenCalledAfter(tx.artifact.update);
  });

  it("imports by value, preserves source audit fields, and never creates a live source relation", async () => {
    const source = sourceVersion();
    const request = { sourceArtifactVersionId: source.id };
    const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([
          { id: "project_source", workspaceId: "workspace_1" },
          { id: "project_target", workspaceId: "workspace_1" },
        ])
        .mockResolvedValueOnce([{ id: source.id }]),
      projectMember: { findUnique: vi.fn()
        .mockResolvedValueOnce({ role: "editor" })
        .mockResolvedValueOnce({ role: "viewer" }) },
      designSystemImport: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => ({ id: "import_1", ...data, createdAt: now })),
      },
      artifact: {
        create: vi.fn().mockResolvedValue({ id: "artifact_target" }),
        update: vi.fn().mockResolvedValue({}),
      },
      artifactVersion: {
        findFirst: vi.fn().mockResolvedValue(source),
        create: vi.fn().mockResolvedValue({ id: "version_target" }),
        update: vi.fn().mockResolvedValue({}),
      },
      artifactVersionAsset: { createMany: vi.fn() },
    };
    const db = {
      designSystemImport: { findUnique: vi.fn().mockResolvedValue(null) },
      artifactVersion: { findFirst: vi.fn().mockResolvedValue(source) },
      $transaction: vi.fn((callback) => callback(tx)),
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };

    const result = await new DesignSystemImportsService(db as never, access as never).create(
      "principal_1",
      "project_target",
      "design:import:12345678",
      request,
    );

    expect(result).toMatchObject({
      sourceProjectId: "project_source",
      sourceArtifactId: "artifact_source",
      sourceArtifactVersionId: "version_source",
      sourceChecksum: source.checksum,
      targetProjectId: "project_target",
      targetArtifactId: "artifact_target",
      targetArtifactVersionId: "version_target",
      requestHash,
    });
    expect(tx.artifactVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "project_target",
        content: source.content,
        checksum: source.checksum,
      }),
    });
    expect(tx.designSystemImport.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ sourceArtifactVersion: expect.anything() }),
    });
  });

  it("rejects direct cross-Workspace imports before writing", async () => {
    const source = sourceVersion({
      artifact: {
        ...sourceVersion().artifact,
        project: { id: "project_source", workspaceId: "workspace_2", status: "active" },
      },
    });
    const db = {
      designSystemImport: { findUnique: vi.fn().mockResolvedValue(null) },
      artifactVersion: { findFirst: vi.fn().mockResolvedValue(source) },
      $transaction: vi.fn(),
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };

    await expect(new DesignSystemImportsService(db as never, access as never).create(
      "principal_1",
      "project_target",
      "design:import:12345678",
      { sourceArtifactVersionId: source.id },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "DESIGN_SYSTEM_IMPORT_CROSS_WORKSPACE" }),
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("replays the same receipt and rejects idempotency-key reuse", async () => {
    const request = { sourceArtifactVersionId: "version_source" };
    const replay = {
      id: "import_1",
      targetProjectId: "project_target",
      targetArtifactId: "artifact_target",
      targetArtifactVersionId: "version_target",
      sourceProjectId: "project_source",
      sourceArtifactId: "artifact_source",
      sourceArtifactVersionId: "version_source",
      sourceChecksum: "a".repeat(64),
      createdById: "principal_1",
      idempotencyKey: "design:import:12345678",
      requestHash: createHash("sha256").update(canonicalJson(request)).digest("hex"),
      createdAt: now,
    };
    const db = {
      designSystemImport: { findUnique: vi.fn().mockResolvedValue(replay) },
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };
    const service = new DesignSystemImportsService(db as never, access as never);

    await expect(service.create(
      "principal_1",
      "project_target",
      replay.idempotencyKey,
      request,
    )).resolves.toMatchObject({ id: "import_1" });
    await expect(service.create(
      "principal_1",
      "project_target",
      replay.idempotencyKey,
      { sourceArtifactVersionId: "version_other" },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
  });

  it("never replays project-scoped creation or import receipts to another editor", async () => {
    const creationRequest = { title: "Product UI", document: documentFixture() };
    const creation = {
      id: "creation_private",
      projectId: "project_target",
      artifactId: "artifact_private",
      artifactVersionId: "version_private",
      checksum: "c".repeat(64),
      createdById: "principal_owner",
      idempotencyKey: "design:create:private",
      requestHash: createHash("sha256").update(canonicalJson(creationRequest)).digest("hex"),
      createdAt: now,
    };
    const importRequest = { sourceArtifactVersionId: "version_source_private" };
    const receipt = {
      id: "import_private",
      targetProjectId: "project_target",
      targetArtifactId: "artifact_target_private",
      targetArtifactVersionId: "version_target_private",
      sourceProjectId: "project_source_private",
      sourceArtifactId: "artifact_source_private",
      sourceArtifactVersionId: "version_source_private",
      sourceChecksum: "a".repeat(64),
      createdById: "principal_owner",
      idempotencyKey: "design:import:private",
      requestHash: createHash("sha256").update(canonicalJson(importRequest)).digest("hex"),
      createdAt: now,
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };
    const creationService = new DesignSystemsService({
      designSystemCreation: { findUnique: vi.fn().mockResolvedValue(creation) },
    } as never, access as never);
    const sourceLookup = vi.fn();
    const importService = new DesignSystemImportsService({
      designSystemImport: { findUnique: vi.fn().mockResolvedValue(receipt) },
      artifactVersion: { findFirst: sourceLookup },
    } as never, access as never);

    const creationFailure = await creationService.create(
      "principal_other_editor",
      creation.projectId,
      creation.idempotencyKey,
      creationRequest,
    ).catch((error: unknown) => error);
    const importFailure = await importService.create(
      "principal_other_editor",
      receipt.targetProjectId,
      receipt.idempotencyKey,
      importRequest,
    ).catch((error: unknown) => error);

    expect(creationFailure).toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
    expect(importFailure).toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
    expect(JSON.stringify((importFailure as { response: unknown }).response))
      .not.toMatch(/project_source_private|artifact_source_private|version_source_private/);
    expect(sourceLookup).not.toHaveBeenCalled();
  });

  it("applies creator ownership after a concurrent project-scoped receipt insert", async () => {
    const request = { title: "Product UI", document: documentFixture() };
    const receipt = {
      id: "creation_raced",
      projectId: "project_target",
      artifactId: "artifact_raced",
      artifactVersionId: "version_raced",
      checksum: "c".repeat(64),
      createdById: "principal_winner",
      idempotencyKey: "design:create:raced",
      requestHash: createHash("sha256").update(canonicalJson(request)).digest("hex"),
      createdAt: now,
    };
    const db = {
      designSystemCreation: {
        findUnique: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(receipt),
      },
      $transaction: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "test" },
      )),
    };
    const access = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };

    await expect(new DesignSystemsService(db as never, access as never).create(
      "principal_loser",
      receipt.projectId,
      receipt.idempotencyKey,
      request,
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });
    expect(db.designSystemCreation.findUnique).toHaveBeenCalledTimes(2);
  });

  it("requires current target edit access but lets the creator replay after source access is revoked", async () => {
    const request = { sourceArtifactVersionId: "version_source" };
    const replay = {
      id: "import_replay",
      targetProjectId: "project_target",
      targetArtifactId: "artifact_target",
      targetArtifactVersionId: "version_target",
      sourceProjectId: "project_source",
      sourceArtifactId: "artifact_source",
      sourceArtifactVersionId: "version_source",
      sourceChecksum: "a".repeat(64),
      createdById: "principal_1",
      idempotencyKey: "design:import:revoked-source",
      requestHash: createHash("sha256").update(canonicalJson(request)).digest("hex"),
      createdAt: now,
    };
    const sourceLookup = vi.fn().mockResolvedValue(null);
    const db = {
      designSystemImport: { findUnique: vi.fn().mockResolvedValue(replay) },
      artifactVersion: { findFirst: sourceLookup },
    };
    const allowedAccess = {
      findProject: vi.fn().mockResolvedValue({ id: "project_target", workspaceId: "workspace_1" }),
    };

    await expect(new DesignSystemImportsService(db as never, allowedAccess as never).create(
      replay.createdById,
      replay.targetProjectId,
      replay.idempotencyKey,
      request,
    )).resolves.toMatchObject({ id: replay.id });
    expect(sourceLookup).not.toHaveBeenCalled();

    const revokedAccess = {
      findProject: vi.fn().mockRejectedValue({
        status: 404,
        response: { code: "RESOURCE_NOT_FOUND" },
      }),
    };
    const replayLookup = vi.fn();
    await expect(new DesignSystemImportsService({
      designSystemImport: { findUnique: replayLookup },
    } as never, revokedAccess as never).create(
      replay.createdById,
      replay.targetProjectId,
      replay.idempotencyKey,
      request,
    )).rejects.toMatchObject({ status: 404 });
    expect(replayLookup).not.toHaveBeenCalled();
  });
});

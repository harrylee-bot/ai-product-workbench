import { Prisma } from "@workbench/workbench-db";
import { ArtifactVersionPreferencesService } from "../src/modules/artifacts/artifact-version-preferences.service.js";

const createdAt = new Date("2026-07-14T08:20:00.000Z");

function storedPreference(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    screenId: "",
    favorite: true,
    reaction: "like" as const,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function favoriteRow(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: "artifact_1",
    artifactVersionId: "version_1",
    screenId: "screen-home",
    updatedAt: createdAt,
    artifactVersion: {
      version: 3,
      content: prototypeDocument(),
      contentBlobId: null,
      artifact: { kind: "prototype", title: "Procurement portal" },
    },
    ...overrides,
  };
}

function createAccess() {
  return { findProject: vi.fn() };
}

function createDb() {
  const db = {
    artifactVersion: { findFirst: vi.fn() },
    artifactVersionPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    projectMember: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: typeof db) => unknown) => operation(db));
  return db;
}

function authorizeViewer(db: ReturnType<typeof createDb>) {
  db.artifactVersion.findFirst.mockResolvedValue({
    projectId: "project_1",
    content: { rows: [] },
    contentBlobId: null,
    artifact: { kind: "data" },
  });
  db.$queryRaw.mockResolvedValue([{ id: "project_1", revision: 3 }]);
  db.projectMember.findUnique.mockResolvedValue({ role: "viewer" });
}

describe("ArtifactVersionPreferencesService", () => {
  it("lists only the current principal's ready Project favourites with a stable cursor", async () => {
    const db = createDb();
    const access = createAccess();
    access.findProject.mockResolvedValue({ id: "project_1" });
    db.artifactVersionPreference.findMany.mockResolvedValue([
      favoriteRow(),
      favoriteRow({
        artifactId: "artifact_2",
        artifactVersionId: "version_2",
        screenId: "",
        updatedAt: new Date("2026-07-13T08:20:00.000Z"),
        artifactVersion: {
          version: 1,
          content: { rows: [] },
          contentBlobId: null,
          artifact: { kind: "data", title: "Research" },
        },
      }),
    ]);
    const service = new ArtifactVersionPreferencesService(db as never, access as never);

    const first = await service.listFavorites("principal_1", "project_1", undefined, 1);

    expect(access.findProject).toHaveBeenCalledWith("principal_1", "project_1", "read");
    expect(db.artifactVersionPreference.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ updatedAt: "desc" }, { artifactVersionId: "desc" }, { screenId: "desc" }],
      take: 2,
      where: expect.objectContaining({
        favorite: true,
        principalId: "principal_1",
        projectId: "project_1",
        artifactVersion: expect.objectContaining({ status: "ready" }),
      }),
    }));
    expect(first).toEqual({
      items: [{
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        artifactKind: "prototype",
        artifactTitle: "Procurement portal",
        artifactVersion: 3,
        screenId: "screen-home",
        screenName: "Home",
        updatedAt: createdAt.toISOString(),
      }],
      nextCursor: expect.any(String),
    });

    db.artifactVersionPreference.findMany.mockResolvedValueOnce([
      favoriteRow({
        artifactId: "artifact_2",
        artifactVersionId: "version_2",
        screenId: "",
        updatedAt: new Date("2026-07-13T08:20:00.000Z"),
        artifactVersion: {
          version: 1,
          content: { rows: [] },
          contentBlobId: null,
          artifact: { kind: "data", title: "Research" },
        },
      }),
    ]);
    await expect(service.listFavorites("principal_1", "project_1", first.nextCursor!, 1))
      .resolves.toMatchObject({
        items: [{ artifactKind: "data", screenId: null, screenName: null }],
        nextCursor: null,
      });
    expect(db.artifactVersionPreference.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.any(Array) }),
    }));
  });

  it("fails closed before listing for an unreadable Project or corrupt Prototype screen target", async () => {
    const deniedDb = createDb();
    const deniedAccess = createAccess();
    deniedAccess.findProject.mockRejectedValue({ status: 404 });
    const denied = new ArtifactVersionPreferencesService(deniedDb as never, deniedAccess as never);

    await expect(denied.listFavorites("principal_2", "project_1", undefined, 30))
      .rejects.toMatchObject({ status: 404 });
    expect(deniedDb.artifactVersionPreference.findMany).not.toHaveBeenCalled();

    const corruptDb = createDb();
    const access = createAccess();
    access.findProject.mockResolvedValue({ id: "project_1" });
    corruptDb.artifactVersionPreference.findMany.mockResolvedValue([
      favoriteRow({ screenId: "screen-missing" }),
    ]);
    const corrupt = new ArtifactVersionPreferencesService(corruptDb as never, access as never);
    await expect(corrupt.listFavorites("principal_1", "project_1", undefined, 30))
      .rejects.toThrow("ARTIFACT_VERSION_FAVORITE_SCREEN_INVALID");
  });

  it("returns a virtual revision 0 default for an authorized missing row", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      content: { rows: [] },
      contentBlobId: null,
      artifact: { kind: "data" },
    });
    db.artifactVersionPreference.findUnique.mockResolvedValue(null);
    const service = new ArtifactVersionPreferencesService(db as never, createAccess() as never);

    await expect(service.get("principal_1", "artifact_1", "version_1", null)).resolves.toEqual({
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      screenId: null,
      favorite: false,
      reaction: null,
      revision: 0,
      createdAt: null,
      updatedAt: null,
    });
    expect(db.artifactVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "version_1",
        artifactId: "artifact_1",
        status: "ready",
        artifact: {
          is: {
            id: "artifact_1",
            project: {
              is: {
                status: "active",
                members: { some: { principalId: "principal_1" } },
              },
            },
          },
        },
      }),
    }));
    expect(db.artifactVersionPreference.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        principalId_artifactVersionId_screenId: {
          principalId: "principal_1",
          artifactVersionId: "version_1",
          screenId: "",
        },
      },
    }));
  });

  it("does not read a different principal's preference", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      content: { rows: [] },
      contentBlobId: null,
      artifact: { kind: "data" },
    });
    db.artifactVersionPreference.findUnique.mockResolvedValue(storedPreference({ reaction: "dislike" }));
    const service = new ArtifactVersionPreferencesService(db as never, createAccess() as never);

    await expect(service.get("principal_2", "artifact_1", "version_1", null))
      .resolves.toMatchObject({ screenId: null });

    expect(db.artifactVersionPreference.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        principalId_artifactVersionId_screenId: {
          principalId: "principal_2",
          artifactVersionId: "version_1",
          screenId: "",
        },
      },
    }));
  });

  it("allows a viewer to create only their own preference from If-Match 0", async () => {
    const db = createDb();
    authorizeViewer(db);
    db.artifactVersionPreference.create.mockResolvedValue(storedPreference());
    const service = new ArtifactVersionPreferencesService(db as never, createAccess() as never);

    await expect(service.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      0,
      { favorite: true, reaction: "like" },
    )).resolves.toMatchObject({ revision: 1, favorite: true, reaction: "like" });

    expect(db.projectMember.findUnique).toHaveBeenCalledWith({
      where: {
        projectId_principalId: { projectId: "project_1", principalId: "principal_1" },
      },
      select: { role: true },
    });
    expect(db.artifactVersionPreference.create).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        principalId: "principal_1",
        projectId: "project_1",
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenId: "",
        favorite: true,
        reaction: "like",
      },
    }));
  });

  it("updates through a principal-scoped revision CAS and increments monotonically", async () => {
    const db = createDb();
    authorizeViewer(db);
    db.artifactVersionPreference.updateMany.mockResolvedValue({ count: 1 });
    db.artifactVersionPreference.findUnique.mockResolvedValue(storedPreference({
      favorite: false,
      reaction: "dislike",
      revision: 2,
    }));
    const service = new ArtifactVersionPreferencesService(db as never, createAccess() as never);

    await expect(service.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      1,
      { favorite: false, reaction: "dislike" },
    )).resolves.toMatchObject({ revision: 2, favorite: false, reaction: "dislike" });

    expect(db.artifactVersionPreference.updateMany).toHaveBeenCalledWith({
      where: {
        principalId: "principal_1",
        artifactVersionId: "version_1",
        screenId: "",
        artifactId: "artifact_1",
        projectId: "project_1",
        revision: 1,
      },
      data: {
        favorite: false,
        reaction: "dislike",
        revision: { increment: 1 },
        updatedAt: expect.any(Date),
      },
    });
  });

  it("returns 412 for a stale revision or a racing revision 0 create", async () => {
    const staleDb = createDb();
    authorizeViewer(staleDb);
    staleDb.artifactVersionPreference.updateMany.mockResolvedValue({ count: 0 });
    const staleService = new ArtifactVersionPreferencesService(staleDb as never, createAccess() as never);

    await expect(staleService.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      1,
      { favorite: false, reaction: null },
    )).rejects.toMatchObject({ status: 412 });

    const racedDb = createDb();
    authorizeViewer(racedDb);
    racedDb.artifactVersionPreference.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique conflict", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const racedService = new ArtifactVersionPreferencesService(racedDb as never, createAccess() as never);
    await expect(racedService.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      0,
      { favorite: true, reaction: null },
    )).rejects.toMatchObject({ status: 412 });
  });

  it("returns 404 before writing for an unknown version or missing read membership", async () => {
    const missingDb = createDb();
    missingDb.artifactVersion.findFirst.mockResolvedValue(null);
    const missingService = new ArtifactVersionPreferencesService(missingDb as never, createAccess() as never);
    await expect(missingService.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      0,
      { favorite: true, reaction: null },
    )).rejects.toMatchObject({ status: 404 });
    expect(missingDb.artifactVersionPreference.create).not.toHaveBeenCalled();

    const unauthorizedDb = createDb();
    unauthorizedDb.artifactVersion.findFirst.mockResolvedValue({
      projectId: "project_1",
      content: { rows: [] },
      contentBlobId: null,
      artifact: { kind: "data" },
    });
    unauthorizedDb.$queryRaw.mockResolvedValue([{ id: "project_1", revision: 3 }]);
    unauthorizedDb.projectMember.findUnique.mockResolvedValue(null);
    const unauthorizedService = new ArtifactVersionPreferencesService(unauthorizedDb as never, createAccess() as never);
    await expect(unauthorizedService.update(
      "principal_2",
      "artifact_1",
      "version_1",
      null,
      0,
      { favorite: true, reaction: "like" },
    )).rejects.toMatchObject({ status: 404 });
    expect(unauthorizedDb.artifactVersionPreference.create).not.toHaveBeenCalled();
  });

  it("requires a real screen on ready Prototype versions and scopes the stored row to it", async () => {
    const db = createDb();
    db.artifactVersion.findFirst.mockResolvedValue({
      projectId: "project_1",
      content: prototypeDocument(),
      contentBlobId: null,
      artifact: { kind: "prototype" },
    });
    db.$queryRaw.mockResolvedValue([{ id: "project_1", revision: 3 }]);
    db.projectMember.findUnique.mockResolvedValue({ role: "viewer" });
    db.artifactVersionPreference.create.mockResolvedValue(storedPreference({
      screenId: "screen-home",
    }));
    const service = new ArtifactVersionPreferencesService(db as never, createAccess() as never);

    await expect(service.get("principal_1", "artifact_1", "version_1", null))
      .rejects.toMatchObject({ status: 400 });

    await expect(service.update(
      "principal_1",
      "artifact_1",
      "version_1",
      "screen-home",
      0,
      { favorite: true, reaction: "like" },
    )).resolves.toMatchObject({ screenId: "screen-home", revision: 1 });
    expect(db.artifactVersionPreference.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ screenId: "screen-home" }),
    }));

    await expect(service.update(
      "principal_1",
      "artifact_1",
      "version_1",
      null,
      0,
      { favorite: true, reaction: null },
    )).rejects.toMatchObject({ status: 400 });
    await expect(service.update(
      "principal_1",
      "artifact_1",
      "version_1",
      "screen-forged",
      0,
      { favorite: true, reaction: null },
    )).rejects.toMatchObject({ status: 404 });
  });
});

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-1",
    title: "Prototype",
    revision: 1,
    screens: [{
      id: "screen-home",
      name: "Home",
      route: "/",
      rootNodeId: "root-home",
      initialStateId: null,
      viewport: { width: 390, height: 844 },
    }],
    nodes: [{
      id: "root-home",
      screenId: "screen-home",
      parentId: null,
      name: "Home",
      kind: "frame" as const,
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
      childIds: [],
      clipContent: true,
    }],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

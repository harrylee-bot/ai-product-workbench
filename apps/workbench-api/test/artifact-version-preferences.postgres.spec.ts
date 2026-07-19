import { createHash } from "node:crypto";
import { canonicalJson, prototypeDocumentSchema } from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { ArtifactVersionPreferencesService } from "../src/modules/artifacts/artifact-version-preferences.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("ArtifactVersion preferences PostgreSQL integration", () => {
  it("isolates principals, permits viewers, and enforces monotonic CAS", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const principalIds: string[] = [];
    let workspaceId: string | undefined;

    try {
      const owner = await db.principal.create({
        data: { issuer: `artifact-pref-${suffix}`, subject: "owner" },
      });
      const viewer = await db.principal.create({
        data: { issuer: `artifact-pref-${suffix}`, subject: "viewer" },
      });
      const outsider = await db.principal.create({
        data: { issuer: `artifact-pref-${suffix}`, subject: "outsider" },
      });
      principalIds.push(owner.id, viewer.id, outsider.id);
      const workspace = await db.workspace.create({
        data: {
          slug: `artifact-pref-${suffix}`,
          name: "Artifact preference integration",
          createdById: owner.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.createMany({
        data: [owner, viewer, outsider].map((principal, index) => ({
          workspaceId: workspace.id,
          principalId: principal.id,
          role: index === 0 ? "owner" : "member",
        })),
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Preference scope",
          },
        });
        await tx.projectMember.createMany({
          data: [{
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          }, {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: viewer.id,
            role: "viewer",
          }],
        });
        return created;
      });
      const artifact = await db.artifact.create({
        data: { projectId: project.id, kind: "data", title: "Research" },
      });
      const version = await db.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          projectId: project.id,
          version: 1,
          schemaVersion: 1,
          status: "ready",
          content: { rows: [] },
          checksum: "a".repeat(64),
          citations: [],
        },
      });
      const service = new ArtifactVersionPreferencesService(
        db as never,
        new AccessService(db as never),
      );

      await expect(service.get(owner.id, artifact.id, version.id, null))
        .resolves.toMatchObject({ revision: 0, favorite: false, reaction: null });
      await expect(service.update(
        owner.id,
        artifact.id,
        version.id,
        null,
        0,
        { favorite: true, reaction: "like" },
      )).resolves.toMatchObject({ revision: 1, favorite: true, reaction: "like" });
      await expect(service.get(viewer.id, artifact.id, version.id, null))
        .resolves.toMatchObject({ revision: 0, favorite: false, reaction: null });
      await expect(service.update(
        viewer.id,
        artifact.id,
        version.id,
        null,
        0,
        { favorite: false, reaction: "dislike" },
      )).resolves.toMatchObject({ revision: 1, reaction: "dislike" });
      await expect(service.update(
        owner.id,
        artifact.id,
        version.id,
        null,
        0,
        { favorite: false, reaction: null },
      )).rejects.toMatchObject({ status: 412 });
      await expect(service.update(
        viewer.id,
        artifact.id,
        version.id,
        null,
        1,
        { favorite: false, reaction: null },
      )).resolves.toMatchObject({ revision: 2, reaction: null });
      await expect(service.get(outsider.id, artifact.id, version.id, null))
        .rejects.toMatchObject({ status: 404 });

      await expect(service.listFavorites(owner.id, project.id))
        .resolves.toMatchObject({
          items: [{ artifactVersionId: version.id, screenId: null }],
          nextCursor: null,
        });
      await expect(service.listFavorites(viewer.id, project.id))
        .resolves.toEqual({ items: [], nextCursor: null });
      await expect(service.listFavorites(outsider.id, project.id))
        .rejects.toMatchObject({ status: 404 });

      const otherProject = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Other preference scope",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        });
        return created;
      });
      const otherArtifact = await db.artifact.create({
        data: { projectId: otherProject.id, kind: "data", title: "Other research" },
      });
      const otherVersion = await db.artifactVersion.create({
        data: {
          artifactId: otherArtifact.id,
          projectId: otherProject.id,
          version: 1,
          schemaVersion: 1,
          status: "ready",
          content: { rows: ["other"] },
          checksum: "b".repeat(64),
          citations: [],
        },
      });
      await service.update(
        owner.id,
        otherArtifact.id,
        otherVersion.id,
        null,
        0,
        { favorite: true, reaction: null },
      );
      await expect(service.listFavorites(owner.id, project.id))
        .resolves.toMatchObject({
          items: [{ artifactVersionId: version.id }],
        });
      await expect(service.listFavorites(owner.id, otherProject.id))
        .resolves.toMatchObject({
          items: [{ artifactVersionId: otherVersion.id }],
        });

      const rows = await db.artifactVersionPreference.findMany({
        where: { artifactVersionId: version.id },
        orderBy: { principalId: "asc" },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.principalId))).toEqual(new Set([owner.id, viewer.id]));
    } finally {
      if (workspaceId) {
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      if (principalIds.length > 0) {
        await db.principal.deleteMany({ where: { id: { in: principalIds } } });
      }
      await db.$disconnect();
    }
  }, 20_000);

  it("isolates one principal's preferences between screens of the same Prototype version", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let principalId: string | undefined;
    let workspaceId: string | undefined;

    try {
      const owner = await db.principal.create({
        data: { issuer: `prototype-pref-${suffix}`, subject: "owner" },
      });
      principalId = owner.id;
      const workspace = await db.workspace.create({
        data: {
          slug: `prototype-pref-${suffix}`,
          name: "Prototype preference integration",
          createdById: owner.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.create({
        data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Prototype preference scope",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        });
        return created;
      });
      const document = prototypeDocumentSchema.parse(prototypeDocument());
      const artifact = await db.artifact.create({
        data: { projectId: project.id, kind: "prototype", title: "Two screens" },
      });
      const version = await db.artifactVersion.create({
        data: {
          artifactId: artifact.id,
          projectId: project.id,
          version: 1,
          schemaVersion: 1,
          status: "ready",
          content: document,
          checksum: createHash("sha256").update(canonicalJson(document)).digest("hex"),
          citations: [],
        },
      });
      const service = new ArtifactVersionPreferencesService(
        db as never,
        new AccessService(db as never),
      );

      await expect(service.update(
        owner.id,
        artifact.id,
        version.id,
        "screen-home",
        0,
        { favorite: true, reaction: "like" },
      )).resolves.toMatchObject({
        screenId: "screen-home",
        favorite: true,
        reaction: "like",
        revision: 1,
      });
      await expect(service.update(
        owner.id,
        artifact.id,
        version.id,
        "screen-success",
        0,
        { favorite: false, reaction: "dislike" },
      )).resolves.toMatchObject({
        screenId: "screen-success",
        favorite: false,
        reaction: "dislike",
        revision: 1,
      });

      await expect(service.get(owner.id, artifact.id, version.id, "screen-home"))
        .resolves.toMatchObject({
          screenId: "screen-home",
          favorite: true,
          reaction: "like",
          revision: 1,
        });
      await expect(service.get(owner.id, artifact.id, version.id, "screen-success"))
        .resolves.toMatchObject({
          screenId: "screen-success",
          favorite: false,
          reaction: "dislike",
          revision: 1,
        });
      await expect(service.get(owner.id, artifact.id, version.id, "screen-forged"))
        .rejects.toMatchObject({ status: 404 });
      await expect(service.get(owner.id, artifact.id, version.id, null))
        .rejects.toMatchObject({ status: 400 });

      const rows = await db.$queryRaw<Array<{
        screenId: string;
        favorite: boolean;
        reaction: "like" | "dislike" | null;
      }>>(Prisma.sql`
        SELECT
          "screen_id" AS "screenId",
          "favorite",
          "reaction"::text AS "reaction"
        FROM "artifact_version_preferences"
        WHERE "principal_id" = ${owner.id}
          AND "artifact_version_id" = ${version.id}
        ORDER BY "screen_id"
      `);
      expect(rows).toEqual([
        { screenId: "screen-home", favorite: true, reaction: "like" },
        { screenId: "screen-success", favorite: false, reaction: "dislike" },
      ]);
      expect(rows.every((row) => row.screenId.length > 0)).toBe(true);
    } finally {
      if (workspaceId) {
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      if (principalId) {
        await db.principal.delete({ where: { id: principalId } }).catch(() => undefined);
      }
      await db.$disconnect();
    }
  }, 20_000);
});

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
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
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-preference",
    title: "Two-screen prototype",
    revision: 1,
    screens: [
      {
        id: "screen-home",
        name: "Home",
        route: "/",
        rootNodeId: "root-home",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
      {
        id: "screen-success",
        name: "Success",
        route: "/success",
        rootNodeId: "root-success",
        initialStateId: null,
        viewport: { width: 390, height: 844 },
      },
    ],
    nodes: [frame("root-home", "screen-home"), frame("root-success", "screen-success")],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

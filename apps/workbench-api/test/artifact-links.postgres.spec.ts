import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { PrismaClient } from "@workbench/workbench-db";
import { ArtifactsService } from "../src/modules/artifacts/artifacts.service.js";
import { ArtifactLinksService } from "../src/modules/artifacts/artifact-links.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("Fixed artifact version links", () => {
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  const artifacts = new ArtifactsService(db as never, {} as never),
    links = new ArtifactLinksService(db as never);
  let fixture: Awaited<ReturnType<typeof setup>>;
  async function setup() {
    const suffix = randomUUID();
    const owner = await db.principal.create({
        data: { issuer: suffix, subject: "owner" },
      }),
      viewer = await db.principal.create({
        data: { issuer: suffix, subject: "viewer" },
      }),
      stranger = await db.principal.create({
        data: { issuer: suffix, subject: "stranger" },
      });
    const workspace = await db.workspace.create({
      data: { slug: suffix, name: "Fixed links", createdById: owner.id },
    });
    await db.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
        { workspaceId: workspace.id, principalId: viewer.id, role: "member" },
      ],
    });
    const { project, other } = await db.$transaction(async (tx) => {
      const project = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Links",
          },
        }),
        other = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Foreign",
          },
        });
      await tx.projectMember.createMany({
        data: [
          {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
          {
            projectId: project.id,
            workspaceId: workspace.id,
            principalId: viewer.id,
            role: "viewer",
          },
          {
            projectId: other.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        ],
      });
      return { project, other };
    });
    async function image(title: string, projectId = project.id) {
      const bytes = Buffer.from(`${suffix}:${title}`),
        sha256 = createHash("sha256").update(bytes).digest("hex");
      const blob = await db.blob.create({
        data: {
          sha256,
          storageKey: `links/${suffix}/${title}`,
          mediaType: "image/png",
          byteSize: BigInt(bytes.length),
          status: "ready",
          verifiedAt: new Date(),
        },
      });
      await db.blobScan.create({
        data: {
          blobId: blob.id,
          attempt: 1,
          status: "clean",
          scanner: "fixture",
          scannerVersion: "1",
          signatureVersion: "1",
          evidence: { result: "clean" },
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      const file = await db.fileAsset.create({
        data: {
          projectId,
          blobId: blob.id,
          uploadedById: owner.id,
          originalName: title + ".png",
          declaredMediaType: "image/png",
          detectedMediaType: "image/png",
          byteSize: blob.byteSize,
          status: "ready",
          verifiedAt: new Date(),
        },
      });
      const result = await artifacts.create(
        owner.id,
        projectId,
        `image:${randomUUID()}`,
        {
          kind: "image",
          title,
          source: { kind: "file", fileAssetId: file.id },
        },
      );
      return { ...result, file, blob };
    }
    const a = await image("Original"),
      b = await image("Target"),
      foreign = await image("Foreign", other.id);
    const a2 = await artifacts.createVersion(
      owner.id,
      a.artifact.id,
      a.artifact.revision,
      `version:${suffix}`,
      {
        kind: "image",
        baseArtifactVersionId: a.artifactVersion.artifactVersionId,
        source: { kind: "file", fileAssetId: b.file.id },
      },
    );
    const staging = await db.artifactVersion.create({
      data: {
        artifactId: b.artifact.id,
        projectId: project.id,
        version: 2,
        schemaVersion: 1,
        status: "staging",
        contentBlobId: b.blob.id,
        checksum: b.blob.sha256,
        citations: [],
      },
    });
    return {
      owner,
      viewer,
      stranger,
      workspace,
      project,
      other,
      a,
      b,
      a2,
      foreign,
      staging,
    };
  }
  const request = () => ({
    source: {
      artifactId: fixture.a.artifact.id,
      artifactVersionId: fixture.a.artifactVersion.artifactVersionId,
    },
    target: {
      artifactId: fixture.b.artifact.id,
      artifactVersionId: fixture.b.artifactVersion.artifactVersionId,
    },
    kind: "reference" as const,
    label: "固定引用",
  });
  beforeAll(async () => {
    fixture = await setup();
  }, 30_000);
  afterAll(async () => {
    await db.$disconnect();
  });

  it("serializes eight duplicate requests and binds receipt to actor, payload and exact old version", async () => {
    const { owner, viewer, stranger, project, a2 } = fixture,
      key = `link:${randomUUID()}`;
    const all = await Promise.all(
      Array.from({ length: 8 }, () =>
        links.create(owner.id, project.id, key, request()),
      ),
    );
    expect(new Set(all.map((item) => item.id)).size).toBe(1);
    expect(all[0]!.source.artifactVersionId).toBe(
      request().source.artifactVersionId,
    );
    expect(all[0]!.source.artifactVersionId).not.toBe(
      a2.detail.artifactVersionId,
    );
    expect(
      await db.artifactLink.count({
        where: { projectId: project.id, idempotencyKey: key },
      }),
    ).toBe(1);
    await expect(
      links.create(owner.id, project.id, key, {
        ...request(),
        label: "changed",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      links.create(viewer.id, project.id, key, request()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(links.list(stranger.id, project.id)).rejects.toMatchObject({
      status: 404,
    });
    await db.projectMember.update({
      where: {
        projectId_principalId: {
          projectId: project.id,
          principalId: viewer.id,
        },
      },
      data: { role: "editor" },
    });
    await expect(
      links.create(viewer.id, project.id, key, request()),
    ).rejects.toMatchObject({ status: 409 });
    await db.projectMember.update({
      where: {
        projectId_principalId: {
          projectId: project.id,
          principalId: viewer.id,
        },
      },
      data: { role: "viewer" },
    });
  });
  it("rejects foreign, mismatched, staging and self endpoints before any row is created", async () => {
    const { owner, project, foreign, staging, b } = fixture;
    for (const target of [
      {
        artifactId: foreign.artifact.id,
        artifactVersionId: foreign.artifactVersion.artifactVersionId,
      },
      {
        artifactId: fixture.a.artifact.id,
        artifactVersionId: request().target.artifactVersionId,
      },
      { artifactId: b.artifact.id, artifactVersionId: staging.id },
    ])
      await expect(
        links.create(owner.id, project.id, `bad:${randomUUID()}`, {
          ...request(),
          target,
        }),
      ).rejects.toMatchObject({ status: 404 });
    await expect(
      links.create(owner.id, project.id, `self:${randomUUID()}`, {
        ...request(),
        target: request().source,
      }),
    ).rejects.toThrow();
  });
  it("paginates both directions, binds cursors and removes once without changing versions or restoring replay", async () => {
    const { owner, viewer, project, a2, other } = fixture;
    const key = `remove:${randomUUID()}`,
      created = await links.create(owner.id, project.id, key, request());
    for (let index = 0; index < 32; index++)
      await links.create(owner.id, project.id, `page:${randomUUID()}`, {
        ...request(),
        label: `page ${index}`,
      });
    const first = await links.list(viewer.id, project.id, {
      artifactVersionId: request().source.artifactVersionId,
      limit: 5,
    });
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBeTruthy();
    for (const scope of [
      { includeRemoved: "true" },
      { artifactVersionId: request().target.artifactVersionId },
    ])
      await expect(
        links.list(owner.id, project.id, {
          artifactVersionId: request().source.artifactVersionId,
          cursor: first.nextCursor,
          ...scope,
        }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      links.list(owner.id, other.id, {
        cursor: first.nextCursor,
        artifactVersionId: request().source.artifactVersionId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await links.list(viewer.id, project.id, {
        artifactVersionId: request().target.artifactVersionId,
        limit: 5,
        cursor,
      });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.length).toBe(34);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      (
        await links.list(owner.id, project.id, {
          artifactVersionId: a2.detail.artifactVersionId,
        })
      ).items,
    ).toEqual([]);
    await expect(
      links.remove(viewer.id, project.id, created.id, 0),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      links.remove(owner.id, project.id, created.id, 1),
    ).rejects.toMatchObject({ status: 412 });
    const removed = await Promise.all(
      Array.from({ length: 8 }, () =>
        links.remove(owner.id, project.id, created.id, 0),
      ),
    );
    expect(
      removed.every(
        (item) =>
          item.revision === 1 && item.removedAt === removed[0]!.removedAt,
      ),
    ).toBe(true);
    expect(
      (await links.create(owner.id, project.id, key, request())).removedAt,
    ).toBe(removed[0]!.removedAt);
    expect(
      (await links.list(owner.id, project.id, { limit: 100 })).items.some(
        (item) => item.id === created.id,
      ),
    ).toBe(false);
    expect(
      (
        await links.list(owner.id, project.id, {
          includeRemoved: "true",
          limit: 100,
        })
      ).items.some((item) => item.id === created.id && item.removedAt),
    ).toBe(true);
    expect(
      (
        await db.artifact.findUniqueOrThrow({
          where: { id: fixture.a.artifact.id },
        })
      ).currentVersionId,
    ).toBe(a2.detail.artifactVersionId);
  });
  it("guards raw endpoint/identity mutation, missing hashes, foreign endpoints and removal restoration", async () => {
    const { owner, project, other } = fixture,
      row = await links.create(
        owner.id,
        project.id,
        `guards:${randomUUID()}`,
        request(),
      );
    const rollback = Error("rollback");
    let passed = false;
    try {
      await db.$transaction(async (tx) => {
        for (const data of [
          { label: "changed" },
          { sourceVersionId: request().target.artifactVersionId },
          { revision: 1 },
          { projectId: other.id },
        ]) {
          await tx.$executeRawUnsafe("SAVEPOINT guard");
          await expect(
            tx.artifactLink.update({ where: { id: row.id }, data }),
          ).rejects.toThrow();
          await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT guard");
        }
        await tx.$executeRawUnsafe("SAVEPOINT guard");
        await expect(
          tx.artifactLink.create({
            data: {
              projectId: project.id,
              sourceVersionId: request().source.artifactVersionId,
              targetVersionId: request().target.artifactVersionId,
              kind: "related",
              createdById: owner.id,
              idempotencyKey: `null:${randomUUID()}`,
              requestHash: null,
            },
          }),
        ).rejects.toThrow();
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT guard");
        await tx.artifactLink.update({
          where: { id: row.id },
          data: { removedAt: new Date(), revision: 1 },
        });
        await tx.$executeRawUnsafe("SAVEPOINT guard");
        await expect(
          tx.artifactLink.update({
            where: { id: row.id },
            data: { removedAt: null, revision: 2 },
          }),
        ).rejects.toThrow();
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT guard");
        passed = true;
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    expect(passed).toBe(true);
  });
  it("saves image plus fixed lineage atomically with duplicate recovery and rollback on link failure", async () => {
    const { owner, viewer, project, a, b, foreign } = fixture;
    const input = {
        kind: "image" as const,
        title: "Saved copy",
        source: { kind: "file" as const, fileAssetId: b.file.id },
        derivedFrom: request().source,
      },
      key = `save-as:${randomUUID()}`;
    const all = await Promise.all(
      Array.from({ length: 8 }, () =>
        artifacts.create(owner.id, project.id, key, input),
      ),
    );
    expect(new Set(all.map((item) => item.artifact.id)).size).toBe(1);
    const copy = all[0]!,
      copyLinks = (
        await links.list(owner.id, project.id, {
          artifactVersionId: copy.artifactVersion.artifactVersionId,
        })
      ).items;
    expect(copyLinks).toHaveLength(1);
    expect(copyLinks[0]).toMatchObject({
      source: request().source,
      target: {
        artifactId: copy.artifact.id,
        artifactVersionId: copy.artifactVersion.artifactVersionId,
      },
      kind: "derived",
      label: "图片另存",
    });
    await expect(
      artifacts.create(viewer.id, project.id, key, input),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      artifacts.create(owner.id, project.id, key, {
        ...input,
        derivedFrom: request().target,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      artifacts.create(owner.id, project.id, `foreign:${randomUUID()}`, {
        ...input,
        derivedFrom: {
          artifactId: foreign.artifact.id,
          artifactVersionId: foreign.artifactVersion.artifactVersionId,
        },
      }),
    ).rejects.toMatchObject({ status: 404 });
    const before = await db.artifact.count({
      where: { projectId: project.id },
    });
    const fault = new Proxy(db, {
      get(target, name) {
        if (name === "$transaction")
          return (callback: (tx: unknown) => unknown) =>
            target.$transaction((tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, property) {
                    if (property === "artifactLink")
                      return new Proxy(inner.artifactLink, {
                        get(delegate, method) {
                          if (method === "create")
                            return () => {
                              throw Error("Injected lineage failure");
                            };
                          return Reflect.get(delegate, method);
                        },
                      });
                    return Reflect.get(inner, property);
                  },
                }),
              ),
            );
        return Reflect.get(target, name);
      },
    });
    await expect(
      new ArtifactsService(fault as never, {} as never).create(
        owner.id,
        project.id,
        `rollback:${randomUUID()}`,
        input,
      ),
    ).rejects.toThrow("Injected lineage failure");
    expect(await db.artifact.count({ where: { projectId: project.id } })).toBe(
      before,
    );
    await links.remove(owner.id, project.id, copyLinks[0]!.id, 0);
    expect(
      (await artifacts.create(owner.id, project.id, key, input)).artifact.id,
    ).toBe(copy.artifact.id);
    expect(
      (
        await links.list(owner.id, project.id, {
          artifactVersionId: copy.artifactVersion.artifactVersionId,
        })
      ).items,
    ).toEqual([]);
    expect(
      await db.artifactVersion.count({ where: { artifactId: a.artifact.id } }),
    ).toBe(2);
  });
});

suite("Artifact link migration", () => {
  it("imports only explicit same-project ready version edges and pins trigger table resolution", async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const schema = `links_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}", public;
        CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE principals(id TEXT PRIMARY KEY);
        CREATE TABLE artifact_versions(id TEXT,artifact_id TEXT,project_id TEXT,status TEXT,UNIQUE(id,project_id));
        CREATE TABLE boards(id TEXT,project_id TEXT); CREATE TABLE board_nodes(board_id TEXT,node_key TEXT,artifact_id TEXT,artifact_version_id TEXT);
        CREATE TABLE board_edges(id TEXT,board_id TEXT,source_node_key TEXT,target_node_key TEXT,kind TEXT,data JSONB);
        INSERT INTO projects VALUES('p'),('other'); INSERT INTO principals VALUES('owner');
        INSERT INTO artifact_versions VALUES('a1','a','p','ready'),('a2','a','p','ready'),('b1','b','p','ready'),('pending','b','p','staging'),('foreign','c','other','ready');
        INSERT INTO boards VALUES('board','p');
        INSERT INTO board_nodes VALUES('board','a','a','a1'),('board','b','b','b1'),('board','loose','a',NULL),('board','shape',NULL,NULL),('board','pending','b','pending'),('board','foreign','c','foreign'),('board','wrong','wrong-artifact','b1');
        INSERT INTO board_edges VALUES ('valid','board','a','b','reference','{"label":"历史引用"}'),('loose','board','loose','b','related','{}'),('shape','board','shape','b','related','{}'),('pending','board','a','pending','related','{}'),('foreign','board','a','foreign','related','{}'),('wrong','board','a','wrong','related','{}');`);
      const sql = await readFile(
        new URL(
          "../../../packages/workbench-db/prisma/migrations/20261116020000_artifact_version_links/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(
        sql.replace(/^BEGIN;\s*/u, "").replace(/COMMIT;\s*$/u, ""),
      );
      expect(
        (
          await client.query(
            "SELECT source_version_id,target_version_id,kind,label,legacy_board_edge_id FROM artifact_links",
          )
        ).rows,
      ).toEqual([
        {
          source_version_id: "a1",
          target_version_id: "b1",
          kind: "reference",
          label: "历史引用",
          legacy_board_edge_id: "valid",
        },
      ]);
      // Run while the caller's path excludes the application schema; the trigger uses TG_TABLE_SCHEMA.
      await client.query("SET LOCAL search_path TO pg_catalog");
      await client.query(
        `INSERT INTO "${schema}".artifact_links(id,project_id,source_version_id,target_version_id,kind,created_by_id,idempotency_key,request_hash) VALUES ('new','p','a2','b1','derived','owner','new-key',repeat('a',64))`,
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "${schema}".artifact_links`,
          )
        ).rows[0].n,
      ).toBe(2);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});

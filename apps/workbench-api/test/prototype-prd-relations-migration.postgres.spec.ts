import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
const url = process.env.WORKBENCH_TEST_DATABASE_URL;
(url ? describe : describe.skip)("prototype PRD relation upgrade", () => {
  it("backfills only unique exact Run/document matches and guards fixed source identities", async () => {
    const client = new pg.Client({ connectionString: url! });
    await client.connect();
    const schema = `prd_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(
        `CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}", public`,
      );
      await client.query(`CREATE TABLE artifacts(id TEXT PRIMARY KEY,kind TEXT);
      CREATE TABLE runs(id TEXT PRIMARY KEY,project_id TEXT,request JSONB);
      CREATE TABLE artifact_versions(id TEXT PRIMARY KEY,artifact_id TEXT,project_id TEXT,created_by_run_id TEXT,content JSONB,status TEXT,schema_version INT,source_prd_version_id TEXT);
      CREATE TABLE prototype_plans(id TEXT,project_id TEXT,content_version INT,root_plan_id TEXT,runtime_run_id TEXT,reused_run_id TEXT);
      CREATE TABLE prototype_revisions(id TEXT,project_id TEXT,plan_id TEXT,version INT,source_document JSONB,created_at TIMESTAMPTZ DEFAULT now());
      INSERT INTO artifacts VALUES ('prototype','prototype'),('prd','prd');
      INSERT INTO runs SELECT 'run-'||n,'project-one','{}'::jsonb FROM generate_series(1,4) n;
      INSERT INTO prototype_plans SELECT 'plan-'||n,'project-one',1,NULL,'run-'||n,NULL FROM generate_series(1,4) n;
      INSERT INTO prototype_revisions(id,project_id,plan_id,version,source_document) SELECT 'revision-'||n,'project-one','plan-'||n,1,'{"body":"same"}'::jsonb FROM generate_series(1,4) n;
      INSERT INTO artifact_versions VALUES
        ('exact','prototype','project-one','run-1','{"body":"same"}','ready',1,NULL),
        ('ambiguous-a','prototype','project-one','run-2','{"body":"same"}','ready',1,NULL),
        ('ambiguous-b','prototype','project-one','run-2','{"body":"same"}','ready',1,NULL),
        ('unrelated-run','prototype','project-one','another-run','{"body":"same"}','ready',1,NULL),
        ('foreign','prototype','another-project','run-4','{"body":"same"}','ready',1,NULL),
        ('prd-one','prd','project-one',NULL,'{}','ready',3,NULL);`);
      const sql = await readFile(
        new URL(
          "../../../packages/workbench-db/prisma/migrations/20261115140000_prototype_prd_relations/migration.sql",
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
            "SELECT id,source_artifact_version_id FROM prototype_revisions ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "revision-1", source_artifact_version_id: "exact" },
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `revision-${i + 2}`,
          source_artifact_version_id: null,
        })),
      ]);
      await client.query("SAVEPOINT immutable_source");
      await expect(
        client.query(
          "UPDATE prototype_revisions SET source_artifact_version_id=NULL WHERE id='revision-1'",
        ),
      ).rejects.toThrow("PROTOTYPE_SOURCE_ARTIFACT_IMMUTABLE");
      await client.query("ROLLBACK TO SAVEPOINT immutable_source");
      await client.query("SAVEPOINT wrong_source");
      await expect(
        client.query(
          "UPDATE prototype_revisions SET source_artifact_version_id='foreign' WHERE id='revision-4'",
        ),
      ).rejects.toThrow("PROTOTYPE_SOURCE_ARTIFACT_MISMATCH");
      await client.query("ROLLBACK TO SAVEPOINT wrong_source");
      await client.query("UPDATE runs SET request=$1 WHERE id='run-1'", [
        JSON.stringify({
          generationIntent: "prd-prototype",
          artifactTargets: [
            { artifactId: "prd", artifactVersionId: "prd-one" },
          ],
        }),
      ]);
      await client.query("SAVEPOINT wrong_prd");
      await expect(
        client.query(
          "INSERT INTO artifact_versions VALUES ('bad-prd','prototype','project-one','run-1','{}','staging',1,NULL)",
        ),
      ).rejects.toThrow("PROTOTYPE_FIXED_PRD_SOURCE_REQUIRED");
      await client.query("ROLLBACK TO SAVEPOINT wrong_prd");
      await client.query(
        "INSERT INTO artifact_versions VALUES ('good-prd','prototype','project-one','run-1','{}','staging',1,'prd-one')",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});

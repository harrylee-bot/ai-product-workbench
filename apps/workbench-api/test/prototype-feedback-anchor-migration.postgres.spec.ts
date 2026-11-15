import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
const url = process.env.WORKBENCH_TEST_DATABASE_URL;

(url ? describe : describe.skip)(
  "prototype feedback anchor upgrade on PostgreSQL",
  () => {
    it("converts canonical nodes and marks unknown selectors missing without losing text or receipt identity", async () => {
      const client = new pg.Client({ connectionString: url! });
      await client.connect();
      const schema = `anchor_upgrade_${randomUUID().replaceAll("-", "")}`;
      try {
        await client.query("BEGIN");
        await client.query(
          `CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}", public`,
        );
        await client.query(`CREATE TABLE prototype_revisions(id TEXT, project_id TEXT, pages JSONB, source_document JSONB);
        CREATE TABLE prototype_feedback(id TEXT, project_id TEXT, revision_id TEXT, created_by_id TEXT, body TEXT, anchor JSONB);
        CREATE TABLE prototype_mutation_receipts(id TEXT, kind TEXT, response JSONB);`);
        await client.query(
          "INSERT INTO prototype_revisions VALUES ($1,$2,$3,$4)",
          [
            "revision-source",
            "project-one",
            JSON.stringify([{ id: "screen-a" }]),
            JSON.stringify({ nodes: [{ id: "node-a", screenId: "screen-a" }] }),
          ],
        );
        const known = {
          pageId: "screen-a",
          selector: 'button[data-wb-node="node-a"]',
          quote: "Original A",
        };
        const unknown = {
          pageId: "screen-a",
          selector: "button",
          quote: "Original unidentified text",
        };
        for (const [id, anchor] of [
          ["known", known],
          ["unknown", unknown],
        ] as const) {
          await client.query(
            "INSERT INTO prototype_feedback VALUES ($1,'project-one','revision-source','author-one',$2,$3)",
            [id, `Body ${id}`, JSON.stringify(anchor)],
          );
          await client.query(
            "INSERT INTO prototype_mutation_receipts VALUES ($1,'feedback_create',$2)",
            [id, JSON.stringify({ id, revisionId: "revision-source", anchor })],
          );
        }
        const migration = await readFile(
          new URL(
            "../../../packages/workbench-db/prisma/migrations/20261115120000_prototype_feedback_nodes/migration.sql",
            import.meta.url,
          ),
          "utf8",
        );
        await client.query(
          migration.replace(/^BEGIN;\s*/u, "").replace(/COMMIT;\s*$/u, ""),
        );
        const rows = (
          await client.query(
            "SELECT id,body,anchor FROM prototype_feedback ORDER BY id",
          )
        ).rows;
        expect(rows).toEqual([
          {
            id: "known",
            body: "Body known",
            anchor: {
              sourceRevisionId: "revision-source",
              scope: "node",
              pageId: "screen-a",
              nodeId: "node-a",
              quote: "Original A",
            },
          },
          {
            id: "unknown",
            body: "Body unknown",
            anchor: {
              sourceRevisionId: "revision-source",
              scope: "unresolved",
              pageId: "screen-a",
              quote: "Original unidentified text",
            },
          },
        ]);
        const receipts = (
          await client.query(
            "SELECT response FROM prototype_mutation_receipts ORDER BY id",
          )
        ).rows;
        expect(receipts.map((row) => row.response.anchor)).toEqual(
          rows.map((row) => row.anchor),
        );
        await client.query("SAVEPOINT immutable_feedback");
        await expect(
          client.query(
            "UPDATE prototype_feedback SET body='Overwrite' WHERE id='known'",
          ),
        ).rejects.toThrow("PROTOTYPE_FEEDBACK_CONTENT_IMMUTABLE");
        await client.query("ROLLBACK TO SAVEPOINT immutable_feedback");
      } finally {
        await client.query("ROLLBACK");
        await client.end();
      }
    }, 30_000);
  },
);

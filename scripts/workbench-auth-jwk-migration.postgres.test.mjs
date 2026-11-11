import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;

test("JWK upgrade preserves legacy keys and accepts algorithm metadata", {
  skip: !databaseUrl,
}, async () => {
  const url = new URL(databaseUrl);
  assert.match(decodeURIComponent(url.pathname.slice(1)), /(?:^|[_-])test(?:$|[_-])/i);
  url.searchParams.delete("schema");
  const client = new pg.Client({ connectionString: url.toString() });
  const schema = `auth_jwk_test_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE auth_jwks (
      id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ
    )`);
    await client.query(`INSERT INTO auth_jwks VALUES
      ('legacy', 'test-public-key', 'test-encrypted-private-key', '2026-11-01T00:00:00Z', NULL)`);
    const before = (await client.query("SELECT * FROM auth_jwks WHERE id = 'legacy'")).rows[0];
    const migration = await readFile(new URL(
      "../packages/workbench-db/prisma/migrations/20261103010000_auth_jwk_algorithm_metadata/migration.sql",
      import.meta.url,
    ), "utf8");
    await client.query(migration);
    const legacy = (await client.query("SELECT * FROM auth_jwks WHERE id = 'legacy'")).rows[0];
    assert.deepEqual(legacy, { ...before, alg: null, crv: null });
    await client.query(`INSERT INTO auth_jwks
      (id, public_key, private_key, created_at, alg, crv) VALUES
      ('rsa', 'test-public-key', 'test-encrypted-private-key', CURRENT_TIMESTAMP, 'RS256', NULL),
      ('ec', 'test-public-key', 'test-encrypted-private-key', CURRENT_TIMESTAMP, 'ES256', 'P-256')`);
    assert.deepEqual((await client.query(
      "SELECT id, alg, crv FROM auth_jwks WHERE id <> 'legacy' ORDER BY id",
    )).rows, [
      { id: "ec", alg: "ES256", crv: "P-256" },
      { id: "rsa", alg: "RS256", crv: null },
    ]);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});

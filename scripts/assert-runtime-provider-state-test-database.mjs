#!/usr/bin/env node

const target = parseDatabaseTarget(
  "WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL",
  process.env.WORKBENCH_RUNTIME_ATTEMPT_TEST_DATABASE_URL,
  true,
);
const shared = process.env.WORKBENCH_TEST_DATABASE_URL?.trim()
  ? parseDatabaseTarget("WORKBENCH_TEST_DATABASE_URL", process.env.WORKBENCH_TEST_DATABASE_URL, false)
  : null;

if (
  shared
  && target.origin === shared.origin
  && target.database === shared.database
  && target.schema === shared.schema
) {
  throw new Error("RUNTIME_PROVIDER_STATE_TEST_DATABASE_NOT_ISOLATED");
}

console.log(`Runtime provider-state test target is isolated: ${target.database}/${target.schema}`);

function parseDatabaseTarget(name, raw, requireTestIdentity) {
  if (!raw?.trim()) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use postgresql:// or postgres://`);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const schema = url.searchParams.get("schema")?.trim() ?? "";
  if (!database || !schema) throw new Error(`${name} must identify a database and schema`);
  if (
    requireTestIdentity
    && !database.toLowerCase().includes("test")
    && !schema.toLowerCase().includes("test")
  ) {
    throw new Error(`${name} must identify an isolated test database or schema`);
  }
  return { origin: url.origin, database, schema };
}

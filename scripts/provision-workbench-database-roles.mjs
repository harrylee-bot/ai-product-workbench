#!/usr/bin/env node

/**
 * Bootstrap the database roles used by the greenfield deployment.
 *
 * The script deliberately connects only as the infrastructure administrator.
 * Prisma migrations run as the migrator role, while application services use
 * the runtime role.  Keeping the grants here (rather than in application code)
 * makes the privilege boundary auditable and repeatable on a fresh database
 * or after restoring a backup.
 */

import pg from "pg";

const { Client } = pg;
const phase = process.argv.find((value) => value.startsWith("--phase="))?.slice("--phase=".length) ?? "bootstrap";
if (!["bootstrap", "grant", "all"].includes(phase)) {
  throw new Error("WORKBENCH_DATABASE_ROLE_PHASE_INVALID");
}

const adminUrl = required("WORKBENCH_POSTGRES_ADMIN_URL");
const migratorRole = identifier(required("WORKBENCH_POSTGRES_MIGRATOR_USER"));
const migratorPassword = required("WORKBENCH_POSTGRES_MIGRATOR_PASSWORD");
const runtimeRole = identifier(required("WORKBENCH_POSTGRES_RUNTIME_USER"));
const runtimePassword = required("WORKBENCH_POSTGRES_RUNTIME_PASSWORD");
if (migratorRole === runtimeRole) throw new Error("WORKBENCH_DATABASE_ROLES_MUST_BE_DISTINCT");

const databaseName = new URL(adminUrl).pathname.replace(/^\//u, "");
if (!databaseName || databaseName.includes("/")) throw new Error("WORKBENCH_POSTGRES_ADMIN_URL_DATABASE_INVALID");
const databaseIdentifier = schemaIdentifier(databaseName);

const client = new Client({
  connectionString: adminUrl,
  application_name: "workbench-database-role-provisioner",
});

try {
  await client.connect();
  await client.query("BEGIN");
  if (phase === "bootstrap" || phase === "all") {
    await ensureRole(client, migratorRole, migratorPassword);
    await ensureRole(client, runtimeRole, runtimePassword);
    await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${migratorRole}, ${runtimeRole}`);
    await client.query(`GRANT CREATE ON DATABASE ${databaseIdentifier} TO ${migratorRole}`);
    await client.query(`REVOKE CREATE ON DATABASE ${databaseIdentifier} FROM ${runtimeRole}`);
    await client.query(`REVOKE CREATE ON SCHEMA ${schemaIdentifier("public")} FROM ${runtimeRole}`);
    for (const schema of ["workbench", "workbench_jobs"]) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdentifier(schema)} AUTHORIZATION ${migratorRole}`);
      await client.query(`ALTER SCHEMA ${schemaIdentifier(schema)} OWNER TO ${migratorRole}`);
      await transferSchemaOwnership(client, schema, migratorRole);
      await client.query(`REVOKE ALL ON SCHEMA ${schemaIdentifier(schema)} FROM ${runtimeRole}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schemaIdentifier(schema)} TO ${runtimeRole}`);
      await client.query(`REVOKE CREATE ON SCHEMA ${schemaIdentifier(schema)} FROM ${runtimeRole}`);
    }
  }
  if (phase === "grant" || phase === "all") {
    await grantRuntimePrivileges(client, runtimeRole, migratorRole);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ status: "ready", phase, database: databaseName }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}

async function ensureRole(client, role, password) {
  const passwordLiteral = await safeLiteral(client, password);
  const result = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.slice(1, -1)]);
  if (result.rowCount === 0) {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD ${passwordLiteral}`);
  } else {
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${passwordLiteral}`);
  }
  await client.query(
    `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
}

async function grantRuntimePrivileges(client, runtimeRole, migratorRole) {
  const appSchema = schemaIdentifier("workbench");
  await client.query(`GRANT USAGE ON SCHEMA ${appSchema} TO ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${appSchema} TO ${runtimeRole}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${appSchema} TO ${runtimeRole}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${appSchema} TO ${runtimeRole}`);
  // New application tables start with append-safe privileges. The explicit
  // all-table grant above promotes ordinary tables after each migration, then
  // the evidence-table exceptions below are re-applied in the same transaction.
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${appSchema} GRANT SELECT, INSERT ON TABLES TO ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${appSchema} REVOKE UPDATE, DELETE, TRUNCATE ON TABLES FROM ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${appSchema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${appSchema} GRANT EXECUTE ON FUNCTIONS TO ${runtimeRole}`);

  // RunEvent is an audit stream. The runtime can append/read it, but only the
  // owning Run's FK cascade may remove rows; UPDATE/DELETE/TRUNCATE are never
  // part of the runtime contract.
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${appSchema}."run_events" FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT ON TABLE ${appSchema}."run_events" TO ${runtimeRole}`);

  // Provider state is a rebuildable projection, but runtime writers only
  // advance it. Direct deletion/truncation is reserved for migrator-led repair.
  await client.query(`REVOKE DELETE, TRUNCATE ON TABLE ${appSchema}."runtime_provider_states" FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${appSchema}."runtime_provider_states" TO ${runtimeRole}`);

  // Provider cancellation convergence is append-only operational evidence.
  // Runtime may record and inspect a resolution, but never rewrite or erase it.
  await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${appSchema}."runtime_provider_cancellation_resolutions" FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT ON TABLE ${appSchema}."runtime_provider_cancellation_resolutions" TO ${runtimeRole}`);

  // Runtime records and deduplicates integrity incidents, but neither runtime
  // nor table-wide grants may erase evidence or issue a forensic retention release.
  await client.query(`REVOKE DELETE, TRUNCATE ON TABLE ${appSchema}."ready_object_integrity_incidents" FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${appSchema}."ready_object_integrity_incidents" TO ${runtimeRole}`);
  await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE ${appSchema}."ready_object_integrity_retention_releases" FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT ON TABLE ${appSchema}."ready_object_integrity_retention_releases" TO ${runtimeRole}`);

  const jobsSchema = schemaIdentifier("workbench_jobs");
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${jobsSchema} AUTHORIZATION ${migratorRole}`);
  await client.query(`ALTER SCHEMA ${jobsSchema} OWNER TO ${migratorRole}`);
  await client.query(`GRANT USAGE ON SCHEMA ${jobsSchema} TO ${runtimeRole}`);
  await client.query(`REVOKE CREATE ON SCHEMA ${jobsSchema} FROM ${runtimeRole}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${jobsSchema} TO ${runtimeRole}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${jobsSchema} TO ${runtimeRole}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${jobsSchema} TO ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${jobsSchema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${jobsSchema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtimeRole}`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migratorRole} IN SCHEMA ${jobsSchema} GRANT EXECUTE ON FUNCTIONS TO ${runtimeRole}`);
}

async function transferSchemaOwnership(client, schema, role) {
  const relations = await client.query(`
    SELECT relation.relname AS name, relation.relkind AS kind
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
    ORDER BY (relation.relkind = 'S'), relation.relname
  `, [schema]);
  for (const relation of relations.rows) {
    const qualified = `${schemaIdentifier(schema)}.${schemaIdentifier(relation.name)}`;
    const command = relation.kind === "S"
      ? "ALTER SEQUENCE"
      : relation.kind === "v"
        ? "ALTER VIEW"
        : relation.kind === "m"
          ? "ALTER MATERIALIZED VIEW"
          : "ALTER TABLE";
    await client.query(`${command} ${qualified} OWNER TO ${role}`);
  }

  const functions = await client.query(`
    SELECT procedure.proname AS name,
           pg_get_function_identity_arguments(procedure.oid) AS arguments
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = $1
    ORDER BY procedure.proname, arguments
  `, [schema]);
  for (const procedure of functions.rows) {
    await client.query(
      `ALTER FUNCTION ${schemaIdentifier(schema)}.${schemaIdentifier(procedure.name)}(${procedure.arguments}) OWNER TO ${role}`,
    );
  }

  const types = await client.query(`
    SELECT type.typname AS name
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = $1
      AND type.typtype IN ('d', 'e')
      AND type.typelem = 0
    ORDER BY type.typname
  `, [schema]);
  for (const type of types.rows) {
    await client.query(
      `ALTER TYPE ${schemaIdentifier(schema)}.${schemaIdentifier(type.name)} OWNER TO ${role}`,
    );
  }
}

async function safeLiteral(client, value) {
  const result = await client.query("SELECT quote_literal($1) AS value", [value]);
  return result.rows[0].value;
}

function schemaIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("WORKBENCH_DATABASE_ROLE_IDENTIFIER_INVALID");
  }
  return schemaIdentifier(value);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const workspace = fileURLToPath(new URL("../packages/workbench-db/", import.meta.url));
const schema = path.join(workspace, "prisma/schema.prisma");
const migrations = path.join(workspace, "prisma/migrations");
const cli = createRequire(path.join(workspace, "package.json")).resolve("prisma/build/index.js");
const predecessor = "20261118100000_export_job_cancellation_transition";
const leaseMigration = "20261118110000_export_job_execution_leases";
const checksum = "20a1e8961f949616cc972e18f4d745a7f4e8bec13a5884151be2cf6cea1f7a26";
const receipt = "workbench:export-cancellation-backfill:v1:" + checksum;
const receiptIndex = "export_jobs_status_execution_lease_expires_at_idx";

function prisma(args, schemaFile = schema) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "migrate", ...args, "--schema", schemaFile],
      {cwd: workspace, stdio: "inherit"});
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error("Prisma migration failed: " + (signal ?? code))));
  });
}

async function deployPredecessors() {
  const prefix = await mkdtemp(path.join(tmpdir(), "workbench-migration-prefix-"));
  try {
    await copyFile(schema, path.join(prefix, "schema.prisma"));
    await mkdir(path.join(prefix, "migrations"));
    for (const entry of await readdir(migrations, {withFileTypes: true})) {
      if (entry.name > predecessor && entry.name !== "migration_lock.toml") continue;
      await cp(path.join(migrations, entry.name), path.join(prefix, "migrations", entry.name), {recursive: true});
    }
    await prisma(["deploy"], path.join(prefix, "schema.prisma"));
  } finally {
    await rm(prefix, {recursive: true, force: true});
  }
}

async function history(client) {
  const {rows: [table]} = await client.query("SELECT to_regclass('workbench._prisma_migrations') IS NOT NULL AS present");
  if (!table.present) return [];
  const {rows} = await client.query(
    "SELECT migration_name, checksum, finished_at FROM workbench._prisma_migrations WHERE migration_name = ANY($1) AND rolled_back_at IS NULL",
    [[predecessor, leaseMigration]]);
  return rows;
}

async function applyLeases(client, sql) {
  // Only the new request timestamp is backfilled. The immutable SQL then
  // validates every row and installs its original constraint, index and guard.
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path = workbench, public");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("LOCK TABLE export_jobs IN ACCESS EXCLUSIVE MODE");
    const {rows: [index]} = await client.query("SELECT obj_description(to_regclass($1), 'pg_class') AS receipt", [receiptIndex]);
    if (index.receipt !== receipt) {
      const firstStatementEnd = sql.indexOf(";") + 1;
      await client.query(sql.slice(0, firstStatementEnd));
      await client.query('ALTER TABLE export_jobs DISABLE TRIGGER export_jobs_mutation_guard');
      const {rowCount} = await client.query("UPDATE export_jobs SET cancel_requested_at = updated_at AT TIME ZONE 'UTC' WHERE status = 'cancelling'");
      await client.query('ALTER TABLE export_jobs ENABLE TRIGGER export_jobs_mutation_guard');
      await client.query(sql.slice(firstStatementEnd));
      // A retry after COMMIT but before Prisma resolve can recognize this exact transaction.
      await client.query("COMMENT ON INDEX " + receiptIndex + " IS '" + receipt + "'");
      console.log("Backfilled historical in-flight export cancellations:", rowCount);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const sql = await readFile(path.join(migrations, leaseMigration, "migration.sql"), "utf8");
if (createHash("sha256").update(sql).digest("hex") !== checksum) throw new Error("Published export lease migration checksum changed");
const url = new URL(process.env.WORKBENCH_DATABASE_URL);
if (url.searchParams.get("schema") !== "workbench") throw new Error("The Workbench migrator requires schema=workbench");
url.searchParams.delete("schema");
const client = new pg.Client({connectionString: url.toString(), application_name: "workbench-migrate"});
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(hashtextextended('workbench:migrate:deployment', 0))");
  const records = await history(client);
  const leases = records.filter(row => row.migration_name === leaseMigration);
  if (leases.some(row => row.checksum !== checksum)) throw new Error("Database export lease migration checksum differs from the published migration");
  if (!leases.some(row => row.finished_at)) {
    if (!records.some(row => row.migration_name === predecessor && row.finished_at)) await deployPredecessors();
    await applyLeases(client, sql);
    await prisma(["resolve", "--applied", leaseMigration]);
  }
  await prisma(["deploy"]);
} finally {
  await client.end();
}

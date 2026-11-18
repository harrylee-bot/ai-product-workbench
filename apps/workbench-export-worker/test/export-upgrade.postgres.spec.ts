import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PrismaClient } from "@workbench/workbench-db";
import pg from "pg";
import { expect, it } from "vitest";
import { seedExport } from "./fixtures/export-job.js";

const run = promisify(execFile);
const base = process.env.WORKBENCH_EXPORT_UPGRADE_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dbDir = path.join(root, "packages/workbench-db");
const cli = createRequire(path.join(dbDir, "package.json")).resolve("prisma/build/index.js");
const leases = "20261118110000_export_job_execution_leases";
const originalChecksum = "20a1e8961f949616cc972e18f4d745a7f4e8bec13a5884151be2cf6cea1f7a26";
const leaseFields = ["cancel_requested_at", "cancellation_acknowledged_at", "execution_owner", "execution_lease_id", "execution_lease_expires_at"];

it.skipIf(!base).each([98, 99])("preserves populated exports and migration history from %i", async (version) => {
  const dbName = "v2_export_upgrade_" + randomUUID().replaceAll("-", "");
  const adminUrl = new URL(base!);
  adminUrl.searchParams.delete("schema");
  const admin = new pg.Client({connectionString: adminUrl.toString()});
  await admin.connect();
  await admin.query("CREATE DATABASE " + dbName);
  const appUrl = new URL(base!);
  appUrl.pathname = "/" + dbName;
  appUrl.searchParams.set("schema", "workbench");
  const sqlUrl = new URL(appUrl);
  sqlUrl.searchParams.delete("schema");
  const sql = new pg.Client({connectionString: sqlUrl.toString()});
  const db = new PrismaClient({datasourceUrl: appUrl.toString()});
  const prefix = await mkdtemp(path.join(tmpdir(), "export-upgrade-test-"));
  try {
    await sql.connect();
    await sql.query("CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto");
    const env = {...process.env, WORKBENCH_DATABASE_URL: appUrl.toString()};
    const schema = path.join(prefix, "schema.prisma");
    await copyFile(path.join(dbDir, "prisma/schema.prisma"), schema);
    await mkdir(path.join(prefix, "migrations"));
    const directory = path.join(dbDir, "prisma/migrations");
    const names = (await readdir(directory, {withFileTypes:true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const name of names.slice(0, version)) {
      await cp(path.join(directory, name), path.join(prefix, "migrations", name), {recursive:true});
    }
    await run(process.execPath, [cli, "migrate", "deploy", "--schema", schema], {cwd: dbDir, env});
    await sql.query("SET search_path TO workbench, public");
    const {releaseId, ownerId, exportJobId: queued} = await seedExport(db, "Historical export release");
    const ids: Record<string,string> = {queued};
    for (const status of ["running", "failed", "succeeded", "cancelled", "cancelling"]) {
      const {id} = await db.exportJob.create({data: {
        releaseId, createdById: ownerId, idempotencyKey: status, requestHash: "a".repeat(64),
        format: "html", packaging: "single_file", selectionKind: "release", options: {historical: status},
      }, select:{id:true}});
      ids[status] = id;
      if (status === "running" || status === "succeeded" || status === "cancelling") {
        await sql.query("UPDATE export_jobs SET status='running', started_at=now(),revision=revision+1 WHERE id=$1", [id]);
      }
      if (version === 99 && status === "running") {
        await sql.query("UPDATE export_jobs SET execution_owner='historical-worker',execution_lease_id='historical-lease',execution_lease_expires_at=now()+interval '1 minute' WHERE id=$1", [id]);
      }
      if (status === "failed") await sql.query("UPDATE export_jobs SET status='failed', failure_code='OLD_FAILURE', failure_detail='original detail', finished_at=now(),revision=revision+1 WHERE id=$1", [id]);
      if (status === "succeeded") {
        await sql.query("INSERT INTO blobs (id,sha256,generation,storage_key,media_type,byte_size,status,verified_at,updated_at) VALUES ('prior-output',$1,1,'prior/content','text/html',8,'ready',now(),now())", ["f".repeat(64)]);
        await sql.query("UPDATE export_jobs SET status='succeeded', output_blob_id='prior-output', finished_at=now(),revision=revision+1 WHERE id=$1", [id]);
      }
      if (status === "cancelling" || status === "cancelled") {
        const request = version === 99 ? ",cancel_requested_at=clock_timestamp()" : "";
        await sql.query("UPDATE export_jobs SET status='cancelling',revision=revision+1"+request+" WHERE id=$1", [id]);
        if (status === "cancelled") {
          const ack = version === 99 ? ",cancellation_acknowledged_at=clock_timestamp()" : "";
          await sql.query("UPDATE export_jobs SET status='cancelled',finished_at=now(),revision=revision+1"+ack+" WHERE id=$1", [id]);
        }
      }
    }
    const snapshot = async () => (await sql.query("SELECT to_jsonb(e)-$1::text[] AS job FROM export_jobs e ORDER BY id", [version === 98 ? leaseFields : []])).rows;
    const history = async () => (await sql.query("SELECT id,migration_name,checksum,started_at,finished_at FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name")).rows;
    const before = await snapshot(), previousHistory = await history();
    const release = (await sql.query("SELECT to_jsonb(r) AS release FROM project_releases r")).rows;
    expect(previousHistory).toHaveLength(version);
    expect(before.map(r => r.job.status).sort()).toEqual(Object.keys(ids).sort());
    const upgrade = () => run(process.execPath, ["scripts/deploy-workbench-migrations.mjs"], {cwd:root, env});
    if (version === 98) {
      // Simulate interruption after the application transaction committed but before Prisma recorded it.
      await sql.query("CREATE FUNCTION interrupt_resolve() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.migration_name = '20261118110000_export_job_execution_leases' THEN RAISE EXCEPTION 'test interrupt resolve'; END IF; RETURN NEW; END$$; CREATE TRIGGER interrupt BEFORE INSERT ON _prisma_migrations FOR EACH ROW EXECUTE FUNCTION interrupt_resolve()");
      await expect(upgrade()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
      expect(await history()).toEqual(previousHistory);
      await sql.query("DROP TRIGGER interrupt ON _prisma_migrations; DROP FUNCTION interrupt_resolve()");
    }
    await Promise.all([upgrade(), upgrade()]);
    expect(await snapshot()).toEqual(before);
    expect((await sql.query("SELECT to_jsonb(r) AS release FROM project_releases r")).rows).toEqual(release);
    const after = await history();
    expect(after.slice(0,version)).toEqual(previousHistory);
    expect(after.map(row => row.migration_name)).toEqual(names);
    expect(after.find(row => row.migration_name === leases).checksum).toBe(originalChecksum);
    if (version === 99) {
      expect((await sql.query("SELECT job_id,owner,lease_id FROM export_active_executions")).rows).toEqual([{job_id:ids.running,owner:"historical-worker",lease_id:"historical-lease"}]);
    }
    if (version === 98) {
      expect((await sql.query("SELECT cancel_requested_at = updated_at AT TIME ZONE 'UTC' AS matched, cancellation_acknowledged_at FROM export_jobs WHERE id=$1", [ids.cancelling])).rows[0]).toEqual({matched:true,cancellation_acknowledged_at:null});
    }
  } finally {
    await db.$disconnect();
    await sql.end();
    await admin.query("DROP DATABASE " + dbName);
    await admin.end();
    await rm(prefix, {recursive:true,force:true});
  }
}, 120_000);

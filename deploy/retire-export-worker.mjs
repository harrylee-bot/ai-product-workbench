import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const id = process.argv[2];
if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Supply the full ID of the stopped Compose export worker");
const format = '{{.Id}} {{.Config.Hostname}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.State.Pid}} {{.State.StartedAt}} {{.State.FinishedAt}}';
const {stdout} = await promisify(execFile)("docker", ["container", "inspect", "--format", format, id]);
const [actualId, host, service, state, pid] = stdout.trim().split(/\s+/);
if (actualId !== id || host !== id.slice(0,12) || service !== "workbench-export-worker" || state !== "exited" || pid !== "0") {
  throw new Error("Docker must confirm the identified export worker has exited with no remaining PID");
}
const url = new URL(process.env.WORKBENCH_DATABASE_URL);
url.searchParams.delete("schema");
const db = new pg.Client({connectionString:url.toString(), application_name:"workbench-export-worker-retirement"});
try {
  await db.connect();
  // Capture the exact set before rechecking Docker. A replacement incarnation
  // starting after that inspection cannot add its attempt to this list.
  const candidates = await db.query("SELECT job_id,lease_id FROM workbench.export_active_executions WHERE split_part(owner,':',1)='export-worker' AND split_part(owner,':',2)=$1", [host]);
  const verified = await promisify(execFile)("docker", ["container", "inspect", "--format", format, id]);
  if (verified.stdout !== stdout) throw new Error("Export worker identity or state changed during verification");
  const {rowCount} = await db.query(
    "DELETE FROM workbench.export_active_executions a USING jsonb_to_recordset($1::jsonb) AS stopped(job_id text,lease_id text) WHERE (a.job_id,a.lease_id)=(stopped.job_id,stopped.lease_id) AND split_part(a.owner,':',2)=$2",
    [JSON.stringify(candidates.rows), host]);
  console.log(JSON.stringify({containerId:id, retiredAttempts:rowCount}));
} finally {
  await db.end();
}

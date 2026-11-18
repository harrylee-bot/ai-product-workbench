import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { expect, it } from "vitest";
import { ExportExecutionLeaseLostError, PrismaExportStore } from "../src/export/export.store.js";
import { digest, seedExport } from "./fixtures/export-job.js";

const url = process.env.WORKBENCH_EXPORT_FENCING_TEST_DATABASE_URL;
const prefixes = {pendingBlobPrefix:"pending/exports", canonicalBlobPrefix:"blobs"};

it.skipIf(!url).each(["publish", "fail", "cancel"])("fences a replaced owner for %s", async action => {
  const a = new PrismaClient({datasourceUrl:url}), b = new PrismaClient({datasourceUrl:url});
  const old = new PrismaExportStore(a,prefixes), current = new PrismaExportStore(b,prefixes);
  try {
    const {exportJobId:id} = await seedExport(a, "Replace an expired export lease");
    const first = await old.start(id,"worker-a");
    if(first.kind !== "run") throw Error("Expected first lease");
    await old.beginExecutionResources(id,first.lease);
    const snapshot = await b.exportJob.findUniqueOrThrow({where:{id}});
    await old.pulseExecutionLease(id,first.lease);
    expect(await b.exportJob.findUniqueOrThrow({where:{id}})).toMatchObject({updatedAt:snapshot.updatedAt,revision:snapshot.revision});
    await a.$executeRaw`UPDATE export_jobs SET execution_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`;
    expect(await old.pulseExecutionLease(id,first.lease)).toBe("lost");
    const second = await current.start(id,"worker-b");
    if(second.kind !== "run") throw Error("Expected replacement lease");
    await current.beginExecutionResources(id,second.lease);
    const reservation = await current.reserveOutput({sha256:digest(randomUUID()),byteSize:10,mediaType:"application/pdf"});
    await expect(old.publishSucceeded(id,reservation,first.lease)).rejects.toBeInstanceOf(ExportExecutionLeaseLostError);
    expect(await old.fail(id,"STALE","discarded",first.lease)).toBe(false);
    await old.releaseExecutionLease(id,first.lease);
    expect(await b.exportJob.findUniqueOrThrow({where:{id}})).toMatchObject({status:"running",executionLeaseId:second.lease.id});
    expect(await b.blob.findUniqueOrThrow({where:{id:reservation.blobId}})).toMatchObject({status:"pending"});
    if(action === "cancel") {
      await b.$executeRaw`UPDATE export_jobs SET status = 'cancelling',cancel_requested_at=clock_timestamp(),revision=revision+1 WHERE id = ${id}`;
      await current.endExecutionResources(id,second.lease);
      expect(await current.acknowledgeCancellation(id,second.lease)).toBe("pending");
      await current.releaseExecutionLease(id,second.lease);
      expect(await current.acknowledgeCancellation(id)).toBe("pending");
      await old.endExecutionResources(id,first.lease);
      expect(await current.acknowledgeCancellation(id)).toBe("cancelled");
    } else {
      await old.endExecutionResources(id,first.lease);
      if(action === "publish") expect(await current.publishSucceeded(id,reservation,second.lease)).toBe("succeeded");
      else expect(await current.fail(id,"NEW_FAILURE","authoritative failure",second.lease)).toBe(true);
      await current.endExecutionResources(id,second.lease);
    }
    expect(await b.exportJob.findUniqueOrThrow({where:{id}})).toMatchObject({status:{publish:"succeeded",fail:"failed",cancel:"cancelled"}[action],executionLeaseId:null});
  } finally {
    await Promise.all([a.$disconnect(),b.$disconnect()]);
  }
});

it.skipIf(!url || !process.env.WORKBENCH_EXPORT_RETIRE_TEST_IMAGE)("releases only the dead container's attempts after Docker confirms its exit", async () => {
  const run = promisify(execFile);
  const image = process.env.WORKBENCH_EXPORT_RETIRE_TEST_IMAGE!;
  const {stdout} = await run("docker", ["run","-d","--init","--label","com.docker.compose.service=workbench-export-worker","--entrypoint","sleep",image,"180"]);
  const id = stdout.trim(), host = id.slice(0,12);
  const db = new PrismaClient({datasourceUrl:url}), store = new PrismaExportStore(db,prefixes);
  const retire = () => run(process.execPath, [fileURLToPath(new URL("../../../deploy/retire-export-worker.mjs",import.meta.url)),id],
    {env:{...process.env,WORKBENCH_DATABASE_URL:url}});
  try {
    const {exportJobId} = await seedExport(db,"Retire stopped container");
    const first = await store.start(exportJobId,"export-worker:"+host+":previous:"+randomUUID());
    if(first.kind !== "run") throw Error("Expected lease");
    await store.beginExecutionResources(exportJobId, first.lease);
    await expect(retire()).rejects.toThrow();
    expect(await db.exportActiveExecution.count({where:{jobId:exportJobId}})).toBe(1);
    await store.retirePreviousContainerRuns(host,"previous");
    expect(await db.exportActiveExecution.count({where:{jobId:exportJobId}})).toBe(1);
    await run("docker",["stop","--time","2",id]);
    const result = await retire();
    expect(JSON.parse(result.stdout)).toEqual({containerId:id,retiredAttempts:1});
    expect(JSON.parse((await retire()).stdout).retiredAttempts).toBe(0);
    expect((await db.exportJob.findUniqueOrThrow({where:{id:exportJobId}})).status).toBe("running");
  } finally {
    await db.$disconnect();
    await run("docker",["rm","-f",id]);
  }
},30_000);

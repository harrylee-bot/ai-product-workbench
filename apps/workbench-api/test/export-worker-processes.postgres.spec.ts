import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigService } from "@nestjs/config";
import { exportCancelQueue } from "@workbench/workbench-contracts";
import { PgBoss } from "pg-boss";
import { expect, it } from "vitest";
import { ExportsService } from "../src/modules/exports/exports.service.js";
import { AccessService } from "../src/modules/access/access.service.js";
import { pgConnectionString, WorkbenchQueueService } from "../src/platform/queue/workbench-queue.service.js";
import { PrismaClient } from "@workbench/workbench-db";
import { fileURLToPath } from "node:url";
import { seedExport } from "../../workbench-export-worker/test/fixtures/export-job.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const executable = process.execPath;
const chromium = process.env.WORKBENCH_EXPORT_CHROMIUM_PATH;
const url = process.env.WORKBENCH_EXPORT_PROCESS_TEST_DATABASE_URL!;
const integrationTest = it.skipIf(!url || !chromium || process.platform === "win32");

type Event = { kind: string; at: string; pid: number; [key: string]: unknown };

async function until<T>(label: string, read: () => T | Promise<T>, timeoutMs = 12_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(35);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for " + label);
}

function startProcess(entry: string, args: string[], endpoint: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: Event[] = [];
  const child = fork(repo + "/" + entry, args, {
    cwd: repo, execPath: executable,
    execArgv: ["--import", repo + "/node_modules/tsx/dist/loader.mjs"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      TSX_TSCONFIG_PATH: repo + "/apps/workbench-export-worker/tsconfig.json",
      OTEL_SDK_DISABLED: "true", AWS_EC2_METADATA_DISABLED: "true",
      WORKBENCH_DATABASE_URL: url, WORKBENCH_S3_INTERNAL_ENDPOINT: endpoint,
      WORKBENCH_EXPORT_S3_ACCESS_KEY_ID: "audit-fixture",
      WORKBENCH_EXPORT_S3_SECRET_ACCESS_KEY: "audit-fixture-secret",
      WORKBENCH_S3_BUCKET: "workbench", WORKBENCH_S3_CONDITIONAL_CREATE_MODE: "s3-if-none-match",
      WORKBENCH_EXPORT_CHROMIUM_PATH: chromium,
    },
  });
  let exited = false;
  child.on("message", (event) => events.push(event as Event));
  child.stdout!.on("data", (buffer) => stdout.push(buffer.toString()));
  child.stderr!.on("data", (buffer) => stderr.push(buffer.toString()));
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
    child.on("error", (error) => { stderr.push(error.message); exited = true; resolve({ code: null, signal: null }); });
  });
  const ensureAlive = () => {
    const failed = events.find((event) => event.kind === "process-error");
    if (failed || exited) throw new Error(JSON.stringify({ entry, events, stdout, stderr }));
  };
  return { child, events, stdout, stderr, exit, ensureAlive };
}

async function stopProcess(run: ReturnType<typeof startProcess> | undefined) {
  if (!run) return null;
  const child: ChildProcess = run.child;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGCONT");
    child.kill("SIGTERM");
    const deadline = Date.now() + 4_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(30);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const exit = await run.exit;
  return { pid: child.pid, exit, events: run.events, stdout: run.stdout.join(""), stderr: run.stderr.join("") };
}

integrationTest.each(["live", "expired"] as const)("checks independent workers with a %s execution lease", async (scenario) => {
  const db = new PrismaClient({datasourceUrl:url});
  const manager = new PgBoss({
    connectionString: pgConnectionString(url), schema: "workbench_jobs",
    migrate: true, createSchema: true, schedule: false, supervise: false, useListenNotify: false,
  });
  manager.on("error", (error) => errors.push(error.message));
  const queue = new WorkbenchQueueService(new ConfigService({ WORKBENCH_DATABASE_URL: url }));
  const errors: string[] = [];
  const puts: { path: string; bytes: number; startedAt: string; closedAt: string | null; response: ServerResponse }[] = [];
  const server = createServer((req, res) => {
    if (req.method === "HEAD") { res.writeHead(404).end(); return; }
    if (req.method !== "PUT") { res.writeHead(405).end(); return; }
    const put = { path: req.url!, bytes: 0, startedAt: new Date().toISOString(), closedAt: null as string | null, response: res };
    res.on("close", () => { put.closedAt = new Date().toISOString(); });
    req.on("data", (buffer) => { put.bytes += buffer.length; });
    req.on("end", () => { puts.push(put); });
  });
  let holder: ReturnType<typeof startProcess> | undefined;
  let consumer: ReturnType<typeof startProcess> | undefined;
  let queueStarted = false;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind the S3 fixture");
    const endpoint = "http://127.0.0.1:" + address.port;
    await manager.start();
    queueStarted = true;
    await queue.onModuleInit();
    const fixture = await seedExport(db, "Cross-process HTML cancellation " + scenario);
    const row = () => db.exportJob.findUniqueOrThrow({ where: { id: fixture.exportJobId } });
    holder = startProcess("apps/workbench-export-worker/test/fixtures/active-export-process.ts", [fixture.exportJobId, scenario], endpoint);
    const holderRun = holder;
    const put = await until("Chromium validation and a blocked AWS SDK PUT", () => { holderRun.ensureAlive(); return puts[0]; });
    expect(put.bytes).toBeGreaterThan(0);
    expect(holder.events.some(({ kind }) => kind === "chromium-validated")).toBe(true);
    expect(put.closedAt).toBeNull();
    const storageKey = new URL(put.path, endpoint).pathname.slice("/workbench/".length);
    const readReservation = () => db.blob.findFirstOrThrow({
      where: { storageKey }, select: { id: true, status: true, gcEligibleAt: true },
    });
    const reserved = await readReservation();
    consumer = startProcess("apps/workbench-export-worker/src/main.ts", [], endpoint);
    const consumerRun = consumer;
    await until("fixed worker's pg-boss subscriptions", () => {
      consumerRun.ensureAlive();
      return consumerRun.stdout.join("").includes("listening on export.build");
    });
    expect(consumer.child.pid).not.toBe(holder.child.pid);

    if (scenario === "expired") {
      expect(holder.child.kill("SIGSTOP")).toBe(true);
    }
    const active = await row();
    expect(active).toMatchObject({ status: "running", revision: 1, executionOwner: "audit-holder:" + holder.child.pid });
    const expiresAt = active.executionLeaseExpiresAt!.getTime();
    if (scenario === "expired") {
      await delay(Math.max(0, expiresAt - Date.now() + 125));
      const stillRunning = await row();
      expect(stillRunning.executionLeaseExpiresAt?.getTime()).toBe(expiresAt);
      expect(stillRunning.status).toBe("running");
      expect(put.closedAt).toBeNull();
    }
    let queueId: string | undefined;
    const send = queue.sendInTransaction.bind(queue);
    queue.sendInTransaction = async (...args) => {
      const id = await send(...args);
      if (args[1] === exportCancelQueue) queueId = id;
      return id;
    };
    const service = new ExportsService(db as never, new AccessService(db as never), queue, {} as never, {} as never, {} as never);
    const accepted = await service.cancel(fixture.ownerId, fixture.exportJobId, active.revision);
    expect(accepted).toMatchObject({ status: "cancelling", revision: 2, finishedAt: null });
    expect(queueId).toBeTruthy();
    const queueJob = () => manager.getJobById(exportCancelQueue, queueId!);

    const postponed = await until("remote consumer defers cleanup acknowledgement", async () => {
      const entry = await queueJob();
      return entry?.state === "retry" && entry;
    }, 25_000);
    expect(JSON.stringify(postponed.output)).toContain("EXPORT_CANCELLATION_ACK_PENDING");
    if (scenario === "expired") {
      expect(put.closedAt).toBeNull();
      expect(await row()).toMatchObject({status:"cancelling", finishedAt:null, cancellationAcknowledgedAt:null});
      expect(holder.child.kill("SIGCONT")).toBe(true);
    }
    const interrupted = await until("AWS SDK abort", () => holderRun.events.find(({kind}) => kind === "storage-interrupted"));
    expect(interrupted).toMatchObject({aborted:true,reasonCode:scenario === "expired" ? "EXPORT_EXECUTION_LEASE_LOST" : "EXPORT_CANCEL_REQUESTED"});
    const closed = await until("aborted upload socket close", () => put.closedAt);
    expect(await row()).toMatchObject({status:"cancelling", finishedAt:null, cancellationAcknowledgedAt:null});
    expect(await readReservation()).toEqual(reserved);
    holder.child.send("release-cleanup");

    const terminal = await until("terminal cancellation", async () => {
      const job = await row();
      return job.status === "cancelled" && job;
    }, 30_000);
    const terminalReservation = await readReservation();
    expect(terminal).toMatchObject({
      status: "cancelled", revision: 3, finishedAt: expect.any(Date), cancellationAcknowledgedAt: expect.any(Date),
      outputBlobId: null, executionOwner: null, executionLeaseId: null, executionLeaseExpiresAt: null,
    });
    const completed = await until("real cancel queue completion", async () => {
      const entry = await queueJob();
      return entry?.state === "completed" && entry;
    }, 26_000);
    expect(completed.output).toMatchObject({ status: "cancelled" });

    expect(Date.parse(closed)).toBeLessThanOrEqual(terminal.finishedAt!.getTime());
    expect(terminalReservation.gcEligibleAt).toBeInstanceOf(Date);
    await until("holder exit", () => holderRun.child.exitCode !== null || holderRun.child.signalCode !== null);
    expect(await holder.exit).toMatchObject({ code: 0 });
    const reservation = await readReservation();
    expect(reservation).toMatchObject({ id: reserved.id, status: "pending", gcEligibleAt: expect.any(Date) });
    expect(reservation.gcEligibleAt!.getTime()).toBeGreaterThan(reserved.gcEligibleAt?.getTime() ?? 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopProcess(holder);
    await stopProcess(consumer);
    if (queueStarted) await queue.onModuleDestroy();
    await manager.stop({ graceful: false });
    await db.$disconnect();
    expect(errors).toEqual([]);
  }
}, 95_000);

integrationTest("rolls back the real queue insert and cancels a never-started export", async () => {
  const db = new PrismaClient({datasourceUrl:url});
  const manager = new PgBoss({
    connectionString: pgConnectionString(url), schema: "workbench_jobs",
    migrate: true, createSchema: true, schedule: false, supervise: false, useListenNotify: false,
  });
  const queue = new WorkbenchQueueService(new ConfigService({ WORKBENCH_DATABASE_URL: url }));
  let consumer: ReturnType<typeof startProcess> | undefined;
  let queueStarted = false;
  try {
    await manager.start();
    queueStarted = true;
    await queue.onModuleInit();
    consumer = startProcess("apps/workbench-export-worker/src/main.ts", [], "http://127.0.0.1:1");
    const consumerRun = consumer;
    await until("fixed worker's pg-boss subscriptions", () => {
      consumerRun.ensureAlive();
      return consumerRun.stdout.join("").includes("listening on export.build");
    });
    const fixture = await seedExport(db, "Queue transaction rollback and queued cancellation");
    const row = () => db.exportJob.findUniqueOrThrow({ where: { id: fixture.exportJobId } });
    const enqueue = queue.sendInTransaction.bind(queue);
    const service = new ExportsService(db as never, new AccessService(db as never), queue, {} as never, {} as never, {} as never);
    let injectedJobId: string | undefined;
    queue.sendInTransaction = async (...args) => {
      injectedJobId = await enqueue(...args);
      throw new Error("AUDIT_FORCE_CANCEL_TRANSACTION_ROLLBACK");
    };
    await expect(service.cancel(fixture.ownerId, fixture.exportJobId, 0)).rejects.toThrow("AUDIT_FORCE_CANCEL_TRANSACTION_ROLLBACK");
    expect(injectedJobId).toBeTruthy();
    const afterRollback = await row();
    const rolledBackJob = await manager.getJobById(exportCancelQueue, injectedJobId!);
    expect(afterRollback).toMatchObject({ status: "queued", revision: 0, cancelRequestedAt: null, executionOwner: null });
    expect(rolledBackJob).toBeNull();
    let acceptedJobId: string | undefined;
    queue.sendInTransaction = async (...args) => {
      acceptedJobId = await enqueue(...args);
      return acceptedJobId;
    };
    const accepted = await service.cancel(fixture.ownerId, fixture.exportJobId, 0);
    expect(accepted).toMatchObject({ status: "cancelling", revision: 1, startedAt: null, finishedAt: null });
    expect(acceptedJobId).toBeTruthy();
    const completed = await until("real queue confirms a queued export", async () => {
      const entry = await manager.getJobById(exportCancelQueue, acceptedJobId!);
      return entry?.state === "completed" && entry;
    });
    const terminal = await row();
    expect(completed.output).toMatchObject({ status: "cancelled" });
    expect(terminal).toMatchObject({
      status: "cancelled", revision: 2, startedAt: null, outputBlobId: null,
      cancellationAcknowledgedAt: expect.any(Date), executionOwner: null, executionLeaseId: null, executionLeaseExpiresAt: null,
    });
  } finally {
    await stopProcess(consumer);
    if (queueStarted) await queue.onModuleDestroy();
    await manager.stop({ graceful: false });
    await db.$disconnect();
  }
}, 25_000);

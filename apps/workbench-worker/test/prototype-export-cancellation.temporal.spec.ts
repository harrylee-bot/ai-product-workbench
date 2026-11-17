import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CancelledFailure, Client, Connection, WorkflowFailedError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { PrismaClient } from "@workbench/workbench-db";
import { describe, expect, it,vi } from "vitest";
import { chromium,type Browser } from 'playwright-core';
import { checkFrozenPrototypeHtml } from '@workbench/workbench-build-worker';
import { PrototypeV2Service } from "../../workbench-api/src/modules/prototypes/prototype-v2.service.js";
import { createPrototypeActivities } from "../src/prototypes/prototype-activities.js";
import { PrototypeExportCancelledError,startPrototypeExport } from "../src/prototypes/prototype-export-state.js";
import { createTemporalSdkActivities } from "../src/prototypes/temporal-sdk-activities.js";

const url = process.env.WORKBENCH_PROTOTYPE_BRIDGE_TEST_DATABASE_URL;
const address = process.env.WORKBENCH_TEMPORAL_TEST_ADDRESS;
(url && address ? describe : describe.skip)("export cancellation with real Temporal and PostgreSQL", () => {
  it.each(['queued','browser-running'] as const)("waits for actual Temporal cleanup after delayed cancellation at %s", async timing => {
    const db = new PrismaClient({ datasourceUrl: url! });
    const connection = await Connection.connect({ address });
    const native = await NativeConnection.connect({ address });
    const id = randomUUID().replaceAll("-", "");
    const owner = await db.principal.create({ data: { issuer: "export-cancellation", subject: id } });
    const workspace = await db.workspace.create({ data: { slug: `cancel-${id}`, name: "Cancellation", createdById: owner.id } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
    const project = await db.$transaction(async tx => {
      const row = await tx.project.create({ data: { workspaceId: workspace.id, createdById: owner.id, title: "Cancellation" } });
      await tx.projectMember.create({ data: { projectId: row.id, workspaceId: workspace.id, principalId: owner.id, role: "owner" } });
      return row;
    });
    const pendingCommands: string[] = [];
    let deliverCancellation:(()=>Promise<void>)|undefined;
    let browser:Browser|undefined,browserValidationActive=false;
    const api = new PrototypeV2Service(db as never, {
      configured: true, startPlan: async () => {}, cancelPlan: async () => {},
      startExport: async () => { pendingCommands.push("start"); }, cancelExport: async () => { pendingCommands.push("cancel");if(!deliverCancellation)throw new Error('fixture gateway unavailable');await deliverCancellation(); },
    }, { get: () => "https://workbench.test" } as never, {} as never);
    try {
      const plan = await db.prototypePlan.create({ data: { projectId: project.id, createdById: owner.id, title: "Fixture", prompt: "Fixture", idempotencyKey: id, requestHash: "a".repeat(64) } });
      const revision = await db.prototypeRevision.create({ data: { projectId: project.id, planId: plan.id, createdById: owner.id, title: "Fixture", status: "ready", pages: [{ id: "page", slug: "home", title: "Home", route: "/", order: 0, content: "<p>Fixture</p>", sha256: "a".repeat(64) }], documentSha256: "b".repeat(64), requestHash: "a".repeat(64), idempotencyKey: id } });
      const exported = await api.createExport({ id: owner.id } as never, project.id, { revisionId: revision.id, format: "html" }, id);
      const row = await db.prototypeExport.findUniqueOrThrow({ where: { id: exported.id } });
      const acceptCancellation=async()=>{
       const current=await db.prototypeExport.findUniqueOrThrow({where:{id:exported.id}});
       const accepted=await api.cancelExport({ id: owner.id } as never, project.id, exported.id, `cancel-${id}`, `"${current.revision}"`, {});
       expect(accepted).toMatchObject({status:'cancelling',finishedAt:null});expect(pendingCommands).toEqual(['start','cancel']);
       const command=await db.prototypeWorkflowCommand.findFirstOrThrow({where:{targetId:exported.id,kind:'export_cancel'}});expect(command).toMatchObject({deliveredAt:null,lastErrorCode:'TEMPORAL_DELIVERY_PENDING'});return command;
      };
      let cancelCommand=timing==='queued'?await acceptCancellation():null;
      const input = { projectId: project.id, exportId: exported.id, commandId: row.activeCommandId!, revisionId: revision.id, format: "html" as const };
      const base = createPrototypeActivities(db, { deerFlowUrl: "https://unused.test", deerFlowToken: "test", artifactBucket: "unused", artifactPrefix: "test" });
      const persist = base.persistPrototypeExport;
      let observedCancellation = false;
      base.persistPrototypeExport = async (...args) => {
        try { return await persist(...args); }
        catch (error) { observedCancellation = error instanceof PrototypeExportCancelledError; throw error; }
      };
      if(timing==='browser-running'){
       const launch=chromium.launch.bind(chromium);vi.spyOn(chromium,'launch').mockImplementation(async options=>browser=await launch(options));
       // Controlled export activity, real Chromium resource and production
       // browser cancellation helper; this is not a React/S3 build acceptance.
       base.persistPrototypeExport=async(input,heartbeat,signal)=>{
        await startPrototypeExport(db,input);
        await checkFrozenPrototypeHtml('<html><body data-wb-prototype="true">Waiting for runtime</body></html>',{executablePath:process.env.WORKBENCH_EXPORT_CHROMIUM_PATH,timeoutMs:30000,signal,onProgress:step=>{heartbeat(step);if(step==='chromium:dom')browserValidationActive=true;}});
        throw new Error('Unexpected uncancelled browser validation');
       };
       const mark=base.markExportCancelled!;base.markExportCancelled=async input=>{expect(browser).toBeDefined();expect(browser!.isConnected()).toBe(false);await mark(input);};
      }
      const taskQueue = `export-cancellation-${id}`;
      const worker = await Worker.create({ connection: native, taskQueue, workflowsPath: fileURLToPath(new URL("../src/prototypes/temporal-sdk-workflows.ts", import.meta.url)), activities: createTemporalSdkActivities(base), maxHeartbeatThrottleInterval: "1 second" });
      const client = new Client({ connection });
      await worker.runUntil(async () => {
        const handle = await client.workflow.start("visualPrototypeExportV3", { taskQueue, workflowId: `export-cancellation-${id}`, args: [input] });
        try {
          await expect.poll(() => timing==='queued'?observedCancellation:browserValidationActive, { timeout: 15000 }).toBe(true);
          if(timing==='browser-running')cancelCommand=await acceptCancellation();
          // Longer than the former three activity attempts: this must stay alive
          // without building, failing or making the cancellation look complete.
          await delay(4000);
          expect((await handle.describe()).status.name).toBe("RUNNING");
          expect(await db.prototypeExport.findUniqueOrThrow({where:{id:exported.id}})).toMatchObject({status:"cancelling",finishedAt:null});
          if(timing==='browser-running')expect(browser!.isConnected()).toBe(true);
          deliverCancellation=()=>handle.cancel();await db.prototypeWorkflowCommand.update({where:{id:cancelCommand!.id},data:{availableAt:new Date(0)}});await api.dispatchPendingCommands(project.id);
          expect((await db.prototypeWorkflowCommand.findUniqueOrThrow({where:{id:cancelCommand!.id}})).deliveredAt).not.toBeNull();
          await expect(handle.result()).rejects.toMatchObject({ cause: expect.any(CancelledFailure) });
          expect((await handle.describe()).status.name).toBe("CANCELLED");
          const history = await handle.fetchHistory();
          expect(history.events?.filter(e => e.activityTaskFailedEventAttributes)).toHaveLength(0);
          expect(history.events?.filter(e => e.activityTaskCanceledEventAttributes)).toHaveLength(1);
          expect(await db.prototypeExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: "cancelled", activeCommandId: input.commandId, artifactKey: null, artifactSha256: null, finishedAt:expect.any(Date) });
          if(timing==='browser-running')expect(browser!.isConnected()).toBe(false);
        } finally {
          if ((await handle.describe()).status.name === "RUNNING") await handle.cancel();
          await handle.result().catch(error => { if (!(error instanceof WorkflowFailedError)) throw error; });
        }
      });
    } finally {
      api.onModuleDestroy();
      vi.restoreAllMocks();await browser?.close();
      await native.close(); await connection.close();
      await db.prototypePlan.deleteMany({ where: { projectId: project.id } });
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.principal.delete({ where: { id: owner.id } });
      await db.$disconnect();
    }
  }, 60000);
});

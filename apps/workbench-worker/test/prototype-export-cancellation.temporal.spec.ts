import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CancelledFailure, Client, Connection, WorkflowFailedError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { PrismaClient } from "@workbench/workbench-db";
import { describe, expect, it } from "vitest";
import { PrototypeV2Service } from "../../workbench-api/src/modules/prototypes/prototype-v2.service.js";
import { createPrototypeActivities } from "../src/prototypes/prototype-activities.js";
import { PrototypeExportCancelledError } from "../src/prototypes/prototype-export-state.js";
import { createTemporalSdkActivities } from "../src/prototypes/temporal-sdk-activities.js";

const url = process.env.WORKBENCH_PROTOTYPE_BRIDGE_TEST_DATABASE_URL;
const address = process.env.WORKBENCH_TEMPORAL_TEST_ADDRESS;
(url && address ? describe : describe.skip)("export cancellation with real Temporal and PostgreSQL", () => {
  it("waits after DB cancellation until the delayed cancellation command reaches Temporal", async () => {
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
    const api = new PrototypeV2Service(db as never, {
      configured: true, startPlan: async () => {}, cancelPlan: async () => {},
      startExport: async () => { pendingCommands.push("start"); }, cancelExport: async () => { pendingCommands.push("cancel"); },
    }, { get: () => "https://workbench.test" } as never, {} as never);
    try {
      const plan = await db.prototypePlan.create({ data: { projectId: project.id, createdById: owner.id, title: "Fixture", prompt: "Fixture", idempotencyKey: id, requestHash: "a".repeat(64) } });
      const revision = await db.prototypeRevision.create({ data: { projectId: project.id, planId: plan.id, createdById: owner.id, title: "Fixture", status: "ready", pages: [{ id: "page", slug: "home", title: "Home", route: "/", order: 0, content: "<p>Fixture</p>", sha256: "a".repeat(64) }], documentSha256: "b".repeat(64), requestHash: "a".repeat(64), idempotencyKey: id } });
      const exported = await api.createExport({ id: owner.id } as never, project.id, { revisionId: revision.id, format: "html" }, id);
      const row = await db.prototypeExport.findUniqueOrThrow({ where: { id: exported.id } });
      await api.cancelExport({ id: owner.id } as never, project.id, exported.id, `cancel-${id}`, `"${row.revision}"`, {});
      expect(pendingCommands).toEqual(["start", "cancel"]);
      const input = { projectId: project.id, exportId: exported.id, commandId: row.activeCommandId!, revisionId: revision.id, format: "html" as const };
      const base = createPrototypeActivities(db, { deerFlowUrl: "https://unused.test", deerFlowToken: "test", artifactBucket: "unused", artifactPrefix: "test" });
      const persist = base.persistPrototypeExport;
      let observedCancellation = false;
      base.persistPrototypeExport = async (...args) => {
        try { return await persist(...args); }
        catch (error) { observedCancellation = error instanceof PrototypeExportCancelledError; throw error; }
      };
      const taskQueue = `export-cancellation-${id}`;
      const worker = await Worker.create({ connection: native, taskQueue, workflowsPath: fileURLToPath(new URL("../src/prototypes/temporal-sdk-workflows.ts", import.meta.url)), activities: createTemporalSdkActivities(base), maxHeartbeatThrottleInterval: "1 second" });
      const client = new Client({ connection });
      await worker.runUntil(async () => {
        const handle = await client.workflow.start("visualPrototypeExportV3", { taskQueue, workflowId: `export-cancellation-${id}`, args: [input] });
        try {
          await expect.poll(() => observedCancellation, { timeout: 15000 }).toBe(true);
          // Longer than the former three activity attempts: this must stay alive
          // without building, failing or making the cancellation look complete.
          await delay(4000);
          expect((await handle.describe()).status.name).toBe("RUNNING");
          await handle.cancel();
          await expect(handle.result()).rejects.toMatchObject({ cause: expect.any(CancelledFailure) });
          expect((await handle.describe()).status.name).toBe("CANCELLED");
          const history = await handle.fetchHistory();
          expect(history.events?.filter(e => e.activityTaskFailedEventAttributes)).toHaveLength(0);
          expect(history.events?.filter(e => e.activityTaskCanceledEventAttributes)).toHaveLength(1);
          expect(await db.prototypeExport.findUniqueOrThrow({ where: { id: exported.id } })).toMatchObject({ status: "cancelled", activeCommandId: input.commandId, artifactKey: null, artifactSha256: null });
        } finally {
          if ((await handle.describe()).status.name === "RUNNING") await handle.cancel();
          await handle.result().catch(error => { if (!(error instanceof WorkflowFailedError)) throw error; });
        }
      });
    } finally {
      api.onModuleDestroy();
      await native.close(); await connection.close();
      await db.prototypePlan.deleteMany({ where: { projectId: project.id } });
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.principal.delete({ where: { id: owner.id } });
      await db.$disconnect();
    }
  }, 60000);
});

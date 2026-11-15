import { randomUUID } from "node:crypto";
import { PrismaClient } from "@workbench/workbench-db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@temporalio/activity", () => ({ cancellationSignal: () => new AbortController().signal, heartbeat: vi.fn(), activityInfo: () => ({ attempt: 1 }) }));
import { PrototypeV2Service } from "../../workbench-api/src/modules/prototypes/prototype-v2.service.js";
import { PrototypeArtifactStorage } from "../src/prototypes/prototype-artifact-storage.js";
import { createPrototypeActivities } from "../src/prototypes/prototype-activities.js";
import { createTemporalSdkActivities } from "../src/prototypes/temporal-sdk-activities.js";
import { assertPrototypeExportActive, finishPrototypeExport, startPrototypeExport } from "../src/prototypes/prototype-export-state.js";

const url = process.env.WORKBENCH_PROTOTYPE_BRIDGE_TEST_DATABASE_URL;
(url ? describe : describe.skip)("Prototype export command fencing on PostgreSQL", () => {
  let db: PrismaClient;
  let projectId: string, workspaceId: string, principalId: string, revisionId: string;
  let api: PrototypeV2Service;
  let activities: ReturnType<typeof createTemporalSdkActivities>;
  const principal = () => ({ id: principalId }) as never;
  const current = (exportId: string) => db.prototypeExport.findUniqueOrThrow({ where: { id: exportId } });
  const exported = () => api.createExport(principal(), projectId, { revisionId, format: "html" }, `export-${randomUUID()}`);
  beforeAll(() => { db = new PrismaClient({ datasourceUrl: url! }); });
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    const id = randomUUID().replaceAll("-", "");
    const owner = await db.principal.create({ data: { issuer: "export-fence", subject: id } }); principalId = owner.id;
    const workspace = await db.workspace.create({ data: { slug: `export-${id}`, name: "Export fence", createdById: principalId } }); workspaceId = workspace.id;
    await db.workspaceMember.create({ data: { workspaceId, principalId, role: "owner" } });
    const project = await db.$transaction(async tx => {
      const row = await tx.project.create({ data: { workspaceId, createdById: principalId, title: "Export fence" } });
      await tx.projectMember.create({ data: { projectId: row.id, workspaceId, principalId, role: "owner" } });
      return row;
    }); projectId = project.id;
    const plan = await db.prototypePlan.create({ data: { projectId, createdById: principalId, title: "Fixture", prompt: "Fixture", idempotencyKey: `plan-${id}`, requestHash: "a".repeat(64) } });
    const revision = await db.prototypeRevision.create({ data: { projectId, planId: plan.id, createdById: principalId, title: "Fixture", status: "ready", pages: [{ id: "page_home", slug: "home", title: "Home", route: "/", order: 0, content: "<p>Fixture</p>", sha256: "a".repeat(64) }], documentSha256: "b".repeat(64), requestHash: "a".repeat(64), idempotencyKey: `revision-${id}` } }); revisionId = revision.id;
    api = new PrototypeV2Service(db as never, { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() }, { get: () => "https://workbench.test" } as never, {} as never);
    activities = createTemporalSdkActivities(createPrototypeActivities(db, { deerFlowUrl: "https://unused.test", deerFlowToken: "local-test", artifactBucket: "unused", artifactPrefix: "test" }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    api?.onModuleDestroy();
    await db.prototypePlan.deleteMany({ where: { projectId } });
    await db.project.delete({ where: { id: projectId } });
    await db.workspace.delete({ where: { id: workspaceId } });
    await db.principal.delete({ where: { id: principalId } });
  });

  it("ignores A failure/cancel replay after the API retries as B, and fences stale build/finish", async () => {
    const result = await exported();
    const a = { projectId, exportId: result.id, revisionId, format: "html" as const, commandId: (await current(result.id)).activeCommandId! };
    await startPrototypeExport(db, a);
    // This is the actual SDK cleanup activity committing before its ACK is lost.
    await activities.markExportFailedV3({ ...a, code: "BUILD_FAILED", detail: "Attempt A failed" });
    const failed = await current(result.id);
    await api.retryExport(principal(), projectId, result.id, "retry-export-b", `"${failed.revision}"`, {});
    const queued = await current(result.id);
    const b = { ...a, commandId: queued.activeCommandId! };
    expect(b.commandId).not.toBe(a.commandId);
    expect(queued.status).toBe("queued");
    await activities.markExportFailedV3({ ...a, code: "BUILD_FAILED", detail: "Lost A ACK replay" });
    await activities.markExportCancelledV3({ ...a, detail: "Late A cancellation" });
    expect(await current(result.id)).toEqual(queued);
    await expect(startPrototypeExport(db, a)).rejects.toThrow("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
    const aArtifact = { key: `private/${a.commandId}.html`, sha256: "c".repeat(64), byteSize: 10, mediaType: "text/html; charset=utf-8" };
    await expect(finishPrototypeExport(db, a, aArtifact)).rejects.toThrow("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
    await startPrototypeExport(db, b);
    await activities.markExportFailedV3({ ...a, code: "OLD_ERROR", detail: "A still replaying" });
    const bArtifact = { ...aArtifact, key: `private/${b.commandId}.html`, sha256: "d".repeat(64) };
    await finishPrototypeExport(db, b, bArtifact);
    const succeeded = await current(result.id);
    expect(succeeded).toMatchObject({ status: "succeeded", activeCommandId: b.commandId, artifactKey: bArtifact.key, failureCode: null });
    await activities.markExportCancelledV3({ ...a, detail: "Late A again" });
    await activities.markExportFailedV3({ ...b, code: "LATE_B_ERROR", detail: "Late cleanup cannot undo success" });
    await finishPrototypeExport(db, b, bArtifact);
    expect(await startPrototypeExport(db, b)).toEqual(bArtifact);
    await db.prototypeRevision.update({ where: { id: revisionId }, data: { status: "rejected", revision: { increment: 1 } } });
    const verify = vi.spyOn(PrototypeArtifactStorage.prototype, "verifyImmutable").mockResolvedValueOnce();
    await expect(activities.persistPrototypeExportV3(b)).resolves.toEqual(bArtifact);
    expect(verify).toHaveBeenCalledWith(bArtifact, expect.any(AbortSignal));
    expect(await current(result.id)).toEqual(succeeded);
  });

  it("binds API cancellation to B and refuses B's late completion", async () => {
    const result = await exported();
    const a = { projectId, exportId: result.id, revisionId, format: "html" as const, commandId: (await current(result.id)).activeCommandId! };
    await activities.markExportFailedV3({ ...a, code: "TEST_FAILURE", detail: "A" });
    const failed = await current(result.id);
    await api.retryExport(principal(), projectId, result.id, "retry-then-cancel", `"${failed.revision}"`, {});
    const b = { ...a, commandId: (await current(result.id)).activeCommandId! };
    await startPrototypeExport(db, b);
    const building = await current(result.id);
    const cancelled = await api.cancelExport(principal(), projectId, result.id, "cancel-current-b", `"${building.revision}"`, {});
    expect(cancelled.status).toBe("cancelled");
    const cancelCommand = await db.prototypeWorkflowCommand.findFirstOrThrow({ where: { projectId, targetId: result.id, kind: "export_cancel" } });
    expect(cancelCommand.payload).toEqual({ commandId: b.commandId });
    await expect(finishPrototypeExport(db, b, { key: "private/late.html", sha256: "e".repeat(64), byteSize: 10, mediaType: "text/html; charset=utf-8" })).rejects.toThrow("PROTOTYPE_EXPORT_CANCELLED");
    await activities.markExportFailedV3({ ...a, code: "OLD_ERROR", detail: "A" });
    expect(await current(result.id)).toMatchObject({ status: "cancelled", activeCommandId: b.commandId, artifactKey: null, artifactSha256: null });
  });

  it.each(["queued", "start-race"])("recognizes same-command cancellation at %s without building or publishing", async timing => {
    const result = await exported();
    const input = { projectId, exportId: result.id, revisionId, format: "html" as const, commandId: (await current(result.id)).activeCommandId! };
    const cancel = async () => {
      const row = await current(result.id);
      await api.cancelExport(principal(), projectId, result.id, "cancel-before-start", `"${row.revision}"`, {});
    };
    if (timing === "queued") await cancel();
    else {
      const update = db.prototypeExport.updateMany.bind(db.prototypeExport);
      vi.spyOn(db.prototypeExport, "updateMany").mockImplementationOnce(async args => {
        await cancel();
        return update(args);
      });
    }
    await expect(startPrototypeExport(db, input)).rejects.toThrow("PROTOTYPE_EXPORT_CANCELLED");
    await expect(assertPrototypeExportActive(db, input)).rejects.toThrow("PROTOTYPE_EXPORT_CANCELLED");
    const cancelled = await current(result.id);
    await activities.markExportFailedV3({ ...input, code: "LATE_FAILURE", detail: "Lost activity reply" });
    expect(await current(result.id)).toEqual(cancelled);
    expect(cancelled).toMatchObject({ status: "cancelled", activeCommandId: input.commandId, artifactKey: null, artifactSha256: null });
    await expect(startPrototypeExport(db, { ...input, commandId: "prototype_command_another_epoch" })).rejects.toThrow("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
    await expect(assertPrototypeExportActive(db, { ...input, projectId: "another-project" })).rejects.toThrow("PROTOTYPE_EXPORT_EXECUTION_CHANGED");
  });

  it("fails closed for absent execution ids and rejects mismatched command scope in the database", async () => {
    const first = await exported(), other = await exported();
    const before = await current(first.id);
    await expect(activities.markExportFailedV3({ projectId, exportId: first.id, code: "UNBOUND", detail: "Old workflow payload" } as never)).rejects.toThrow("PROTOTYPE_EXPORT_COMMAND_REQUIRED");
    await expect(db.prototypeExport.update({ where: { id: first.id }, data: { activeCommandId: (await current(other.id)).activeCommandId } })).rejects.toThrow(/command scope/u);
    expect(await current(first.id)).toEqual(before);
  });
});

import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@workbench/workbench-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrototypeActivities } from "../src/prototypes/prototype-activities.js";
const url = process.env.WORKBENCH_PROTOTYPE_BRIDGE_TEST_DATABASE_URL;
(url ? describe : describe.skip)("Prototype share revocation durable activity replay", () => {
  let db: PrismaClient;
  beforeAll(() => { db = new PrismaClient({ datasourceUrl: url! }); });
  afterAll(() => db.$disconnect());
  it("commits CAS and result together, replays after acknowledgement loss and rejects a competing old CAS", async () => {
    const rollback = new Error("ROLLBACK_SHARE_ACTIVITY_FIXTURE");
    await expect(db.$transaction(async tx => {
      const suffix = randomUUID().replaceAll("-", "");
      const owner = await tx.principal.create({ data: { issuer: "share-replay", subject: suffix } });
      const workspace = await tx.workspace.create({ data: { slug: `share-${suffix}`, name: "Share", createdById: owner.id } });
      const project = await tx.project.create({ data: { workspaceId: workspace.id, createdById: owner.id, title: "Share" } });
      const plan = await tx.prototypePlan.create({ data: { projectId: project.id, createdById: owner.id, title: "Share", prompt: "Share", idempotencyKey: `share-${suffix}`, requestHash: "a".repeat(64) } });
      const revision = await tx.prototypeRevision.create({ data: { projectId: project.id, planId: plan.id, createdById: owner.id, title: "Share", pages: [], documentSha256: "b".repeat(64), status: "ready", idempotencyKey: `revision-${suffix}`, requestHash: "a".repeat(64) } });
      const share = await tx.prototypeShare.create({ data: { projectId: project.id, revisionId: revision.id, createdById: owner.id, tokenHash: "c".repeat(64), idempotencyKey: `share-${suffix}`, requestHash: "a".repeat(64) } });
      const command = await tx.prototypeWorkflowCommand.create({ data: { id: `command-${suffix}`, projectId: project.id, targetId: share.id, kind: "share_revoke", payload: { expectedRevision: "0" } } });
      const scoped = { ...tx, $transaction: (fn: (client: Prisma.TransactionClient) => unknown) => fn(tx) };
      const activities = createPrototypeActivities(scoped as never, { deerFlowUrl: "https://unused.test", deerFlowToken: "local-test", artifactBucket: "unused", artifactPrefix: "test" });
      const input = { projectId: project.id, shareId: share.id, expectedRevision: 0, commandId: command.id };
      const first = await activities.revokePrototypeShare(input);
      expect(first).toEqual({ ok: true, revision: 1, status: "revoked" });
      expect(await activities.revokePrototypeShare(input)).toEqual(first);
      expect(await tx.prototypeShare.findUnique({ where: { id: share.id } })).toMatchObject({ status: "revoked", revision: 1 });
      const other = await tx.prototypeWorkflowCommand.create({ data: { id: `other-${suffix}`, projectId: project.id, targetId: share.id, kind: "share_revoke", payload: { expectedRevision: "0" } } });
      expect(await activities.revokePrototypeShare({ ...input, commandId: other.id })).toEqual({ ok: false, status: "active" });
      expect(await activities.revokePrototypeShare({ ...input, commandId: other.id })).toEqual({ ok: false, status: "active" });
      throw rollback;
    }, { timeout: 30_000 })).rejects.toBe(rollback);
  });
});

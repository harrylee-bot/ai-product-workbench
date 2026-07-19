import { PrismaClient } from "@workbench/workbench-db";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Project invitation PostgreSQL constraints", () => {
  it("allows a Project member without granting Workspace membership", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let workspaceId: string | undefined;
    try {
      const [owner, invitee] = await Promise.all([
        db.principal.create({
          data: { issuer: `invitation-access-${suffix}`, subject: `owner-${suffix}` },
        }),
        db.principal.create({
          data: {
            issuer: `invitation-access-${suffix}`,
            subject: `invitee-${suffix}`,
            email: `invitee-${suffix}@example.com`,
          },
        }),
      ]);
      const workspace = await db.workspace.create({
        data: {
          slug: `invitation-access-${suffix}`,
          name: "Invitation access isolation test",
          createdById: owner.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.create({
        data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Invitation access isolation test",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        });
        return created;
      });

      const membership = await db.projectMember.create({
        data: {
          projectId: project.id,
          workspaceId: workspace.id,
          principalId: invitee.id,
          role: "viewer",
        },
        include: { principal: true },
      });

      expect(membership.principal.email).toBe(`invitee-${suffix}@example.com`);
      await expect(db.workspaceMember.findUnique({
        where: {
          workspaceId_principalId: {
            workspaceId: workspace.id,
            principalId: invitee.id,
          },
        },
      })).resolves.toBeNull();
      await expect(db.project.findFirst({
        where: {
          id: project.id,
          members: { some: { principalId: invitee.id } },
        },
      })).resolves.toMatchObject({ id: project.id });
    } finally {
      if (workspaceId) {
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      await db.$disconnect();
    }
  });

  it("enforces normalized pending uniqueness and terminal lifecycle fields", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let workspaceId: string | undefined;
    try {
      const owner = await db.principal.create({
        data: { issuer: `invitation-test-${suffix}`, subject: `owner-${suffix}` },
      });
      const workspace = await db.workspace.create({
        data: {
          slug: `invitation-test-${suffix}`,
          name: "Invitation constraint test",
          createdById: owner.id,
        },
      });
      workspaceId = workspace.id;
      await db.workspaceMember.create({
        data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
      });
      const project = await db.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            createdById: owner.id,
            title: "Invitation constraint test",
          },
        });
        await tx.projectMember.create({
          data: {
            projectId: created.id,
            workspaceId: workspace.id,
            principalId: owner.id,
            role: "owner",
          },
        });
        return created;
      });
      const invitation = await db.projectInvitation.create({
        data: {
          projectId: project.id,
          workspaceId: workspace.id,
          email: "invitee@example.com",
          role: "editor",
          createdById: owner.id,
          idempotencyKey: "constraint-invite-1",
          requestHash: "1".repeat(64),
          tokenHash: "2".repeat(64),
          tokenKeyId: "3".repeat(16),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await expect(db.projectInvitation.create({
        data: {
          projectId: project.id,
          workspaceId: workspace.id,
          email: "invitee@example.com",
          role: "viewer",
          createdById: owner.id,
          idempotencyKey: "constraint-invite-2",
          requestHash: "4".repeat(64),
          tokenHash: "5".repeat(64),
          tokenKeyId: "6".repeat(16),
          expiresAt: new Date(Date.now() + 60_000),
        },
      })).rejects.toBeDefined();

      await expect(db.projectInvitation.update({
        where: { id: invitation.id },
        data: { status: "accepted", revision: { increment: 1 } },
      })).rejects.toBeDefined();

      await expect(db.$executeRawUnsafe(`
        UPDATE "project_invitations"
        SET "email" = 'CHANGED@example.com'
        WHERE "id" = $1
      `, invitation.id)).rejects.toBeDefined();
    } finally {
      if (workspaceId) {
        await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      await db.$disconnect();
    }
  });
});

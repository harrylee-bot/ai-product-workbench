import {
  boardNodeProtocol,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { Prisma, PrismaClient } from "@workbench/workbench-db";
import { AccessService } from "../src/modules/access/access.service.js";
import { BoardsService } from "../src/modules/boards/boards.service.js";

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

type BoardFixture = {
  baseRevision: number;
  boardId: string;
  ownerId: string;
  projectId: string;
  workspaceId: string;
};

describeWithPostgres("Board logical command PostgreSQL integration", () => {
  it("increments once for a non-empty replace and keeps ordinary child writes fail-safe", async () => {
    const db = new PrismaClient({ datasourceUrl: databaseUrl });
    let fixture: BoardFixture | undefined;

    try {
      fixture = await seedBoardFixture(db, uniqueSuffix("single"));
      const service = new BoardsService(db as never, new AccessService(db as never));
      const command = replacement("single");
      const idempotencyKey = `board-replace:${fixture.projectId}:single`;

      const result = await service.replace(
        fixture.ownerId,
        fixture.projectId,
        fixture.baseRevision,
        idempotencyKey,
        command,
      );

      expect(result).toMatchObject({
        id: fixture.boardId,
        projectId: fixture.projectId,
        revision: fixture.baseRevision + 1,
      });
      expect(result.nodes.map((node) => node.id).sort())
        .toEqual(command.nodes.map((node) => node.id).sort());
      expect(result.edges.map((edge) => edge.id).sort())
        .toEqual(command.edges.map((edge) => edge.id).sort());

      const receipt = await db.boardReplaceReceipt.findUniqueOrThrow({
        where: {
          projectId_idempotencyKey: {
            projectId: fixture.projectId,
            idempotencyKey,
          },
        },
      });
      expect(receipt).toMatchObject({
        boardId: fixture.boardId,
        expectedRevision: fixture.baseRevision,
        resultRevision: fixture.baseRevision + 1,
      });
      expect(receipt.response).toMatchObject({ revision: fixture.baseRevision + 1 });

      await db.boardNode.update({
        where: {
          boardId_nodeKey: {
            boardId: fixture.boardId,
            nodeKey: command.nodes[0]!.id,
          },
        },
        data: { position: { x: 111, y: 222 } },
      });
      const afterOrdinaryWrite = await db.board.findUniqueOrThrow({
        where: { id: fixture.boardId },
        select: { revision: true },
      });
      expect(afterOrdinaryWrite.revision).toBe(fixture.baseRevision + 2);

      await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT
            set_config('workbench.board_revision_owner', ${fixture!.boardId}, TRUE),
            set_config(
              'workbench.board_revision_owner_revision',
              ${String(afterOrdinaryWrite.revision - 1)},
              TRUE
            )
        `);
        await tx.boardNode.update({
          where: {
            boardId_nodeKey: {
              boardId: fixture!.boardId,
              nodeKey: command.nodes[0]!.id,
            },
          },
          data: { position: { x: 333, y: 444 } },
        });
      });
      const afterMismatchedOwner = await db.board.findUniqueOrThrow({
        where: { id: fixture.boardId },
        select: { revision: true },
      });
      expect(afterMismatchedOwner.revision).toBe(afterOrdinaryWrite.revision + 1);
    } finally {
      await cleanupBoardFixture(db, fixture);
      await db.$disconnect();
    }
  }, 20_000);

  it("allows only one command to win when different keys race on the same revision", async () => {
    const setup = new PrismaClient({ datasourceUrl: databaseUrl });
    const left = new PrismaClient({ datasourceUrl: databaseUrl });
    const right = new PrismaClient({ datasourceUrl: databaseUrl });
    let fixture: BoardFixture | undefined;

    try {
      fixture = await seedBoardFixture(setup, uniqueSuffix("race"));
      const leftService = new BoardsService(left as never, new AccessService(left as never));
      const rightService = new BoardsService(right as never, new AccessService(right as never));

      const results = await Promise.allSettled([
        leftService.replace(
          fixture.ownerId,
          fixture.projectId,
          fixture.baseRevision,
          `board-replace:${fixture.projectId}:left`,
          replacement("left"),
        ),
        rightService.replace(
          fixture.ownerId,
          fixture.projectId,
          fixture.baseRevision,
          `board-replace:${fixture.projectId}:right`,
          replacement("right"),
        ),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<BoardsService["replace"]>>> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        status: 412,
        response: expect.objectContaining({ code: "REVISION_MISMATCH" }),
      });
      expect(fulfilled[0]!.value.revision).toBe(fixture.baseRevision + 1);

      const [board, receipts] = await Promise.all([
        setup.board.findUniqueOrThrow({
          where: { id: fixture.boardId },
          select: { revision: true },
        }),
        setup.boardReplaceReceipt.findMany({
          where: { projectId: fixture.projectId },
        }),
      ]);
      expect(board.revision).toBe(fixture.baseRevision + 1);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        expectedRevision: fixture.baseRevision,
        resultRevision: fixture.baseRevision + 1,
      });
    } finally {
      await Promise.all([left.$disconnect(), right.$disconnect()]);
      await cleanupBoardFixture(setup, fixture);
      await setup.$disconnect();
    }
  }, 20_000);
});

async function seedBoardFixture(db: PrismaClient, suffix: string): Promise<BoardFixture> {
  const owner = await db.principal.create({
    data: { issuer: `board-revision-${suffix}`, subject: "owner" },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `board-revision-${suffix}`,
      name: "Board revision integration",
      createdById: owner.id,
    },
  });
  await db.workspaceMember.create({
    data: { workspaceId: workspace.id, principalId: owner.id, role: "owner" },
  });
  const project = await db.project.create({
    data: {
      workspaceId: workspace.id,
      createdById: owner.id,
      title: "Board logical command",
      members: {
        create: {
          principalId: owner.id,
          role: "owner",
        },
      },
    },
  });
  const board = await db.board.create({
    data: { projectId: project.id, viewport: { x: 0, y: 0, zoom: 1 } },
  });
  await db.boardNode.createMany({
    data: [
      storedFrame(board.id, project.id, "old-left", 0, 0),
      storedFrame(board.id, project.id, "old-right", 1, 500),
    ],
  });
  await db.boardEdge.create({
    data: {
      boardId: board.id,
      edgeKey: "old-edge",
      sourceNodeKey: "old-left",
      targetNodeKey: "old-right",
      kind: "flow",
      data: {},
    },
  });
  const seeded = await db.board.findUniqueOrThrow({
    where: { id: board.id },
    select: { revision: true },
  });
  return {
    baseRevision: seeded.revision,
    boardId: board.id,
    ownerId: owner.id,
    projectId: project.id,
    workspaceId: workspace.id,
  };
}

function storedFrame(
  boardId: string,
  projectId: string,
  nodeKey: string,
  sortOrder: number,
  x: number,
) {
  return {
    boardId,
    projectId,
    nodeKey,
    sortOrder,
    kind: "frame",
    position: { x, y: 0 },
    size: { width: 400, height: 800 },
    data: {
      protocol: boardNodeProtocol,
      nodeType: "frame",
      title: nodeKey,
      fill: null,
      stroke: "#5f6368",
    },
  };
}

function replacement(label: string): ReplaceBoardRequest {
  const left = `new-${label}-left`;
  const right = `new-${label}-right`;
  return {
    viewport: { x: 10, y: 20, zoom: 0.9 },
    nodes: [
      boardFrame(left, 0, 40),
      boardFrame(right, 1, 520),
    ],
    edges: [{
      id: `new-${label}-edge`,
      sourceNodeId: left,
      targetNodeId: right,
      kind: "flow",
      data: { label },
    }],
  };
}

function boardFrame(id: string, order: number, x: number): ReplaceBoardRequest["nodes"][number] {
  return {
    id,
    kind: "frame",
    parentNodeId: null,
    order,
    position: { x, y: 60 },
    size: { width: 400, height: 800 },
    artifactId: null,
    artifactVersionId: null,
    data: {
      protocol: boardNodeProtocol,
      nodeType: "frame",
      title: id,
      fill: null,
      stroke: "#5f6368",
    },
  };
}

async function cleanupBoardFixture(db: PrismaClient, fixture?: BoardFixture) {
  if (!fixture) return;
  await db.workspace.delete({ where: { id: fixture.workspaceId } }).catch(() => undefined);
  await db.principal.delete({ where: { id: fixture.ownerId } }).catch(() => undefined);
}

function uniqueSuffix(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

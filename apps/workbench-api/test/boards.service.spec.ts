import type { Response } from "express";
import {
  boardNodeProtocol,
  type Board,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { hashRequest } from "../src/common/idempotency.js";
import { BoardsController } from "../src/modules/boards/boards.controller.js";
import { BoardsService } from "../src/modules/boards/boards.service.js";

const idempotencyKey = "board-replace:key-1";
const input: ReplaceBoardRequest = {
  viewport: { x: 12, y: 24, zoom: 0.8 },
  nodes: [
    {
      id: "frame_1",
      kind: "frame",
      parentNodeId: null,
      order: 0,
      position: { x: 40, y: 60 },
      size: { width: 640, height: 480 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Main flow",
        fill: null,
        stroke: "#5f6368",
      },
    },
  ],
  edges: [],
};

const firstResult: Board = {
  id: "board_1",
  projectId: "project_1",
  revision: 1,
  ...input,
};

function savedBoard(revision = 1) {
  const node = input.nodes[0]!;
  return {
    id: "board_1",
    projectId: "project_1",
    revision,
    viewport: input.viewport,
    nodes: [
      {
        nodeKey: node.id,
        parentNodeKey: node.parentNodeId,
        sortOrder: node.order,
        kind: node.kind,
        position: node.position,
        size: node.size,
        artifactId: node.artifactId,
        artifactVersionId: node.artifactVersionId,
        data: node.data,
      },
    ],
    edges: [],
  };
}

function createHarness(options: {
  boardRevision?: number;
  ownerState?: { boardId: string | null; revision: string | null };
  savedRevision?: number;
  transactionReplay?: ReturnType<typeof receipt> | null;
} = {}) {
  let persistedReceipt: ReturnType<typeof receipt> | null = null;
  const tx = {
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
      .mockResolvedValueOnce([{
        id: "board_1",
        revision: options.boardRevision ?? 0,
      }])
      .mockResolvedValueOnce([options.ownerState ?? { boardId: null, revision: null }])
      .mockResolvedValueOnce([{
        boardId: "board_1",
        revision: String((options.boardRevision ?? 0) + 1),
      }])
      .mockResolvedValueOnce([{ boardId: "", revision: "" }]),
    projectMember: {
      findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
    },
    boardReplaceReceipt: {
      findUnique: vi.fn().mockImplementation(async () => options.transactionReplay ?? persistedReceipt),
      create: vi.fn().mockImplementation(async ({ data }: { data: ReturnType<typeof receipt> }) => {
        persistedReceipt = data;
        return data;
      }),
    },
    artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
    board: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(savedBoard(options.savedRevision ?? 1)),
    },
    boardEdge: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    boardNode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const db = {
    boardReplaceReceipt: {
      findUnique: vi.fn().mockImplementation(async () => persistedReceipt),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const access = { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) };
  return {
    tx,
    db,
    access,
    service: new BoardsService(db as never, access as never),
    getPersistedReceipt: () => persistedReceipt,
  };
}

function receipt(overrides: Partial<{
  projectId: string;
  boardId: string;
  expectedRevision: number;
  resultRevision: number;
  createdById: string;
  idempotencyKey: string;
  requestHash: string;
  response: Board;
}> = {}) {
  return {
    projectId: "project_1",
    boardId: "board_1",
    expectedRevision: 0,
    resultRevision: 1,
    createdById: "principal_1",
    idempotencyKey,
    requestHash: hashRequest(input),
    response: firstResult,
    ...overrides,
  };
}

describe("Board replace idempotency", () => {
  it("atomically records the first result and recovers it after a lost response", async () => {
    const { service, tx, db, getPersistedReceipt } = createHarness();

    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      idempotencyKey,
      input,
    )).resolves.toEqual(firstResult);

    expect(tx.boardReplaceReceipt.create).toHaveBeenCalledWith({
      data: receipt(),
    });
    expect(getPersistedReceipt()).toEqual(receipt());
    const boardLock = tx.$queryRaw.mock.calls[1]?.[0] as { strings?: string[] };
    expect(boardLock.strings?.join(" ")).toContain("FOR UPDATE");
    const ownerRead = tx.$queryRaw.mock.calls[2]?.[0] as { strings?: string[] };
    const ownerClaim = tx.$queryRaw.mock.calls[3]?.[0] as { strings?: string[] };
    const ownerRelease = tx.$queryRaw.mock.calls[4]?.[0] as { strings?: string[] };
    expect(ownerRead.strings?.join(" ")).toContain("current_setting");
    expect(ownerClaim.strings?.join(" ")).toContain("set_config");
    expect(ownerRelease.strings?.join(" ")).toContain("set_config");
    expect(tx.board.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[3]!);
    expect(tx.$queryRaw.mock.invocationCallOrder[3])
      .toBeLessThan(tx.boardEdge.deleteMany.mock.invocationCallOrder[0]!);
    expect(tx.boardNode.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[4]!);
    expect(tx.$queryRaw.mock.invocationCallOrder[4])
      .toBeLessThan(tx.boardReplaceReceipt.create.mock.invocationCallOrder[0]!);

    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      idempotencyKey,
      input,
    )).resolves.toEqual(firstResult);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.board.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.boardReplaceReceipt.create).toHaveBeenCalledTimes(1);
  });

  it("returns a concurrent receipt before evaluating the now-stale revision", async () => {
    const concurrentReceipt = receipt();
    const { service, tx } = createHarness({
      boardRevision: 1,
      transactionReplay: concurrentReceipt,
    });

    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      idempotencyKey,
      input,
    )).resolves.toEqual(firstResult);

    expect(tx.boardReplaceReceipt.findUnique).toHaveBeenCalled();
    expect(tx.board.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a reused key when either the payload or caller changes", async () => {
    const payloadHarness = createHarness();
    payloadHarness.db.boardReplaceReceipt.findUnique.mockResolvedValue(receipt());
    await expect(payloadHarness.service.replace(
      "principal_1",
      "project_1",
      0,
      idempotencyKey,
      { ...input, viewport: { ...input.viewport, x: 99 } },
    )).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    });

    const callerHarness = createHarness();
    callerHarness.db.boardReplaceReceipt.findUnique.mockResolvedValue(receipt());
    await expect(callerHarness.service.replace(
      "principal_2",
      "project_1",
      0,
      idempotencyKey,
      input,
    )).rejects.toMatchObject({ status: 409 });
    expect(payloadHarness.db.$transaction).not.toHaveBeenCalled();
    expect(callerHarness.db.$transaction).not.toHaveBeenCalled();
  });

  it("retains normal compare-and-swap failure for a new command key", async () => {
    const { service, tx } = createHarness({ boardRevision: 2 });
    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      "board-replace:key-2",
      input,
    )).rejects.toMatchObject({
      status: 412,
      response: expect.objectContaining({ code: "REVISION_MISMATCH" }),
    });
    expect(tx.board.updateMany).not.toHaveBeenCalled();
    expect(tx.boardReplaceReceipt.create).not.toHaveBeenCalled();
  });

  it("fails closed when another logical command already owns Board child revision writes", async () => {
    const { service, tx } = createHarness({
      ownerState: { boardId: "board_other", revision: "8" },
    });

    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      "board-replace:key-owner-conflict",
      input,
    )).rejects.toThrow("BOARD_REVISION_OWNER_ALREADY_CLAIMED");

    expect(tx.boardEdge.deleteMany).not.toHaveBeenCalled();
    expect(tx.boardNode.deleteMany).not.toHaveBeenCalled();
    expect(tx.boardReplaceReceipt.create).not.toHaveBeenCalled();
  });

  it("refuses to persist a receipt when child writes changed the logical result revision", async () => {
    const { service, tx } = createHarness({ savedRevision: 2 });

    await expect(service.replace(
      "principal_1",
      "project_1",
      0,
      "board-replace:key-invalid-result",
      input,
    )).rejects.toThrow("BOARD_LOGICAL_COMMAND_REVISION_INVALID");

    expect(tx.boardReplaceReceipt.create).not.toHaveBeenCalled();
  });
});

describe("BoardsController", () => {
  it("requires and forwards Idempotency-Key while returning the result revision ETag", async () => {
    const boards = { replace: vi.fn().mockResolvedValue(firstResult) };
    const controller = new BoardsController(boards as never);
    const response = { setHeader: vi.fn() };

    await expect(controller.replace(
      { id: "principal_1" } as never,
      "project_1",
      '"0"',
      undefined,
      input,
      response as unknown as Response,
    )).rejects.toMatchObject({ status: 400 });
    expect(boards.replace).not.toHaveBeenCalled();

    await expect(controller.replace(
      { id: "principal_1" } as never,
      "project_1",
      '"0"',
      idempotencyKey,
      input,
      response as unknown as Response,
    )).resolves.toEqual(firstResult);
    expect(boards.replace).toHaveBeenCalledWith(
      "principal_1",
      "project_1",
      0,
      idempotencyKey,
      input,
    );
    expect(response.setHeader).toHaveBeenCalledWith("ETag", '"1"');
  });
});

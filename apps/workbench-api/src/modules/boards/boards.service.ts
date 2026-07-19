import { Injectable } from "@nestjs/common";
import { Prisma } from "@workbench/workbench-db";
import {
  boardSchema,
  type Board,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { hashRequest, validateIdempotencyKey } from "../../common/idempotency.js";
import {
  idempotencyConflictProblem,
  notFoundProblem,
  revisionConflictProblem,
  validationProblem,
} from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { AccessService } from "../access/access.service.js";
import { artifactVersionScreenIds } from "../artifacts/artifact-screen-reference.js";
import { lockActiveProject } from "../projects/project-lock.js";
import { withBoardRevisionOwner } from "./board-revision-owner.js";
import { mapBoard } from "./board.mapper.js";

@Injectable()
export class BoardsService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly access: AccessService,
  ) {}

  async get(principalId: string, projectId: string): Promise<Board> {
    await this.access.findProject(principalId, projectId, "read");
    const board = await this.db.board.findUniqueOrThrow({
      where: { projectId },
      include: { nodes: true, edges: true },
    });
    return mapBoard(board);
  }

  async replace(
    principalId: string,
    projectId: string,
    expectedRevision: number,
    idempotencyKey: string,
    input: ReplaceBoardRequest,
  ): Promise<Board> {
    validateIdempotencyKey(idempotencyKey);
    await this.access.findProject(principalId, projectId, "edit");
    const requestHash = hashRequest(input);
    const replay = await this.findReplay(projectId, idempotencyKey);
    if (replay) return resolveReplay(replay, principalId, requestHash);

    validateBoardGraph(input);

    try {
      return await this.db.$transaction(async (tx) => {
        await lockActiveProject(tx, projectId, principalId, "edit");
        const boards = await tx.$queryRaw<Array<{ id: string; revision: number }>>(Prisma.sql`
          SELECT "id", "revision"
          FROM "boards"
          WHERE "project_id" = ${projectId}
          FOR UPDATE
        `);
        const board = boards[0];
        if (!board) throw notFoundProblem("Project board");

        const duplicate = await tx.boardReplaceReceipt.findUnique({
          where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        });
        if (duplicate) return resolveReplay(duplicate, principalId, requestHash);
        if (board.revision !== expectedRevision) throw revisionConflictProblem();

        await this.assertArtifactReferences(tx, projectId, input);
        const updated = await tx.board.updateMany({
          where: { id: board.id, projectId, revision: expectedRevision },
          data: {
            viewport: input.viewport,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw revisionConflictProblem();

        const resultRevision = expectedRevision + 1;
        await withBoardRevisionOwner(tx, board.id, resultRevision, async () => {
          await tx.boardEdge.deleteMany({ where: { boardId: board.id } });
          await tx.boardNode.deleteMany({ where: { boardId: board.id } });

          if (input.nodes.length) {
            await tx.boardNode.createMany({
              data: input.nodes.map((node) => ({
                boardId: board.id,
                projectId,
                nodeKey: node.id,
                parentNodeKey: node.parentNodeId,
                sortOrder: node.order,
                kind: node.kind,
                position: node.position,
                ...(node.size === null ? {} : { size: node.size }),
                artifactId: node.artifactId,
                artifactVersionId: node.artifactVersionId,
                data: node.data as Prisma.InputJsonValue,
              })),
            });
          }
          if (input.edges.length) {
            await tx.boardEdge.createMany({
              data: input.edges.map((edge) => ({
                boardId: board.id,
                edgeKey: edge.id,
                sourceNodeKey: edge.sourceNodeId,
                targetNodeKey: edge.targetNodeId,
                kind: edge.kind,
                data: edge.data as Prisma.InputJsonValue,
              })),
            });
          }
        });

        const saved = await tx.board.findUniqueOrThrow({
          where: { id: board.id },
          include: { nodes: true, edges: true },
        });
        const result = mapBoard(saved);
        if (result.revision !== resultRevision) {
          throw new Error("BOARD_LOGICAL_COMMAND_REVISION_INVALID");
        }
        await tx.boardReplaceReceipt.create({
          data: {
            projectId,
            boardId: board.id,
            expectedRevision,
            resultRevision: result.revision,
            createdById: principalId,
            idempotencyKey,
            requestHash,
            response: result as Prisma.InputJsonValue,
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.findReplay(projectId, idempotencyKey);
        if (raced) return resolveReplay(raced, principalId, requestHash);
      }
      throw error;
    }
  }

  private findReplay(projectId: string, idempotencyKey: string) {
    return this.db.boardReplaceReceipt.findUnique({
      where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
    });
  }

  private async assertArtifactReferences(
    client: Pick<Prisma.TransactionClient, "artifactVersion">,
    projectId: string,
    input: ReplaceBoardRequest,
  ) {
    const references = input.nodes.filter(
      (node): node is typeof node & { artifactId: string; artifactVersionId: string } =>
        node.artifactId !== null && node.artifactVersionId !== null,
    );
    if (!references.length) return;

    const versionIds = [...new Set(references.map((node) => node.artifactVersionId))];
    const versions = await client.artifactVersion.findMany({
      where: { id: { in: versionIds } },
      include: { artifact: true },
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    const screenIdsByVersion = new Map<string, ReadonlySet<string> | null>();
    for (const reference of references) {
      const version = byId.get(reference.artifactVersionId);
      if (
        !version
        || version.status !== "ready"
        || version.artifactId !== reference.artifactId
        || version.artifact.projectId !== projectId
        || reference.data.nodeType !== "artifact"
        || version.artifact.kind !== reference.data.artifactKind
      ) {
        throw validationProblem(`Board node ${reference.id} references an invalid artifact version`);
      }
      if (reference.data.screenId !== undefined) {
        let screenIds = screenIdsByVersion.get(version.id);
        if (screenIds === undefined) {
          screenIds = artifactVersionScreenIds(version);
          screenIdsByVersion.set(version.id, screenIds);
        }
        if (!screenIds?.has(reference.data.screenId)) {
          throw validationProblem(
            `Board node ${reference.id} references a screen outside its artifact version`,
          );
        }
      }
    }
  }
}

function resolveReplay(
  receipt: { createdById: string; requestHash: string; response: unknown },
  principalId: string,
  requestHash: string,
) {
  if (receipt.createdById !== principalId || receipt.requestHash !== requestHash) {
    throw idempotencyConflictProblem();
  }
  return boardSchema.parse(receipt.response);
}

export function validateBoardGraph(input: ReplaceBoardRequest) {
  const nodeIds = new Set<string>();
  const siblingOrders = new Map<string | null, Set<number>>();
  for (const node of input.nodes) {
    if (nodeIds.has(node.id)) throw validationProblem(`Duplicate Board node id: ${node.id}`);
    nodeIds.add(node.id);
    const orders = siblingOrders.get(node.parentNodeId) ?? new Set<number>();
    if (orders.has(node.order)) {
      throw validationProblem(
        `Duplicate Board sibling order ${node.order} under parent ${node.parentNodeId ?? "root"}`,
      );
    }
    orders.add(node.order);
    siblingOrders.set(node.parentNodeId, orders);
    if ((node.artifactId === null) !== (node.artifactVersionId === null)) {
      throw validationProblem(`Board node ${node.id} must pin both artifactId and artifactVersionId`);
    }
  }

  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  for (const node of input.nodes) {
    if (node.parentNodeId === null) continue;
    const parent = nodesById.get(node.parentNodeId);
    if (!parent) throw validationProblem(`Board node ${node.id} references a missing parent`);
    if (parent.kind !== "frame") {
      throw validationProblem(`Board node ${node.id} must be parented by a frame`);
    }

    const ancestors = new Set<string>([node.id]);
    let parentId: string | null = node.parentNodeId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) {
        throw validationProblem(`Board node ${node.id} contains a parent cycle`);
      }
      ancestors.add(parentId);
      parentId = nodesById.get(parentId)?.parentNodeId ?? null;
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (edgeIds.has(edge.id)) throw validationProblem(`Duplicate Board edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw validationProblem(`Board edge ${edge.id} references a missing node`);
    }
  }
}

import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SystemGraphService, type SystemEdge, type SystemGraphSnapshot, type SystemNode } from "./system.graph.service";

export type SystemMutation = {
  id: string;
  type: "add_agent" | "remove_agent" | "modify_agent" | "modify_pipeline" | "add_step" | "remove_step";
  target: string;
  payload: unknown;
  reason: string;
  riskLevel: "low" | "medium" | "high";
};

type PipelineMutationPayload = {
  addEdges?: SystemEdge[];
  removeEdges?: SystemEdge[];
};

const PROTECTED_TARGETS = new Set(["auth", "jwt", "database", "prisma", "security", "core_safety"]);

@Injectable()
export class MutationEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graphs: SystemGraphService,
  ) {}

  validate(mutation: SystemMutation, graph: SystemGraphSnapshot) {
    if (!mutation.id || !mutation.type || !mutation.target || !mutation.reason) {
      throw new ForbiddenException("SystemMutation schema check failed.");
    }
    if (PROTECTED_TARGETS.has(mutation.target)) {
      throw new ForbiddenException("核心安全模块禁止自生成修改");
    }
    if (mutation.type === "add_agent" && !isNodePayload(mutation.payload)) {
      throw new ForbiddenException("add_agent mutation requires a valid SystemNode payload.");
    }
    if (mutation.type === "add_step" && !isEdgePayload(mutation.payload)) {
      throw new ForbiddenException("add_step mutation requires a valid SystemEdge payload.");
    }
    if (mutation.type === "modify_pipeline" && !isPipelinePayload(mutation.payload)) {
      throw new ForbiddenException("modify_pipeline mutation requires addEdges/removeEdges payload.");
    }
    if ((mutation.type === "add_step" || mutation.type === "remove_step") && isEdgePayload(mutation.payload)) {
      this.assertEdgeDependencies(mutation.payload, graph);
    }
    if (mutation.type === "modify_pipeline" && isPipelinePayload(mutation.payload)) {
      [...(mutation.payload.addEdges ?? []), ...(mutation.payload.removeEdges ?? [])].forEach((edge) =>
        this.assertEdgeDependencies(edge, graph),
      );
    }
    if (mutation.type === "remove_agent" && !graph.nodes.some((node) => node.id === mutation.target)) {
      throw new ForbiddenException("目标 Agent 不存在");
    }
    return true;
  }

  previewApply(graph: SystemGraphSnapshot, mutations: SystemMutation[]): SystemGraphSnapshot {
    let next: SystemGraphSnapshot = {
      version: graph.version,
      nodes: graph.nodes.map((node) => ({ ...node, config: { ...node.config } })),
      edges: graph.edges.map((edge) => ({ ...edge })),
    };

    mutations.forEach((mutation) => {
      this.validate(mutation, next);
      next = applyOne(next, mutation);
    });

    return next;
  }

  async applyProposal(input: {
    projectId: string;
    proposalId: string;
    confirm?: boolean;
    createdBy: string;
  }) {
    const proposal = await this.prisma.systemChangeProposal.findFirst({
      where: {
        id: input.proposalId,
        projectId: input.projectId,
      },
    });
    if (!proposal) throw new NotFoundException("SystemChangeProposal 不存在");
    if (proposal.status === "applied") return { status: "already_applied", proposalId: proposal.id };
    if (proposal.riskLevel === "high") throw new ForbiddenException("High risk proposal is blocked.");
    if (proposal.riskLevel === "medium" && !input.confirm) {
      throw new ForbiddenException("Medium risk proposal requires confirmation.");
    }

    const mutations = toMutations(proposal.mutations);
    const graph = await this.graphs.saveGraphVersion(
      input.projectId,
      input.createdBy,
      toGraphSnapshot(proposal.previewGraph),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.systemChangeProposal.update({
        where: { id: proposal.id },
        data: {
          status: "applied",
          appliedGraphId: graph.id,
          appliedAt: new Date(),
        },
      });
      await tx.systemMutationLog.createMany({
        data: mutations.map((mutation) => ({
          projectId: input.projectId,
          proposalId: proposal.id,
          graphId: graph.id,
          mutation: mutation as unknown as Prisma.InputJsonValue,
          status: "applied",
          rollbackData: {
            previousGraphVersion: graph.version - 1,
          } as Prisma.InputJsonValue,
          result: {
            graphId: graph.id,
            graphVersion: graph.version,
          } as Prisma.InputJsonValue,
          createdBy: input.createdBy,
        })),
      });
    });

    return {
      status: "applied",
      proposalId: proposal.id,
      graph,
      mutations,
    };
  }

  async rollback(input: { projectId: string; logId: string; createdBy: string }) {
    const log = await this.prisma.systemMutationLog.findFirst({
      where: { id: input.logId, projectId: input.projectId },
    });
    if (!log) throw new NotFoundException("SystemMutationLog 不存在");
    const rollbackData = toRollbackData(log.rollbackData);
    const previousVersion = rollbackData?.previousGraphVersion;
    if (typeof previousVersion !== "number") {
      throw new ForbiddenException("该 MutationLog 缺少可回滚图版本");
    }
    const previousGraph = await this.prisma.systemGraph.findFirst({
      where: { projectId: input.projectId, version: previousVersion },
    });
    if (!previousGraph) throw new NotFoundException("回滚目标 SystemGraph 不存在");
    const graph = await this.graphs.saveGraphVersion(input.projectId, input.createdBy, {
      version: previousGraph.version,
      nodes: toNodes(previousGraph.nodes),
      edges: toEdges(previousGraph.edges),
    });
    await this.prisma.systemMutationLog.create({
      data: {
        projectId: input.projectId,
        graphId: graph.id,
        mutation: {
          type: "rollback",
          target: log.id,
        } as Prisma.InputJsonValue,
        status: "rollback_applied",
        rollbackData: log.rollbackData ?? Prisma.JsonNull,
        result: {
          rolledBackLogId: log.id,
          graphId: graph.id,
          graphVersion: graph.version,
        } as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { status: "rollback_applied", rolledBackLogId: log.id, graph };
  }

  private assertEdgeDependencies(edge: SystemEdge, graph: SystemGraphSnapshot) {
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new ForbiddenException("Pipeline edge dependency check failed.");
    }
  }
}

function applyOne(graph: SystemGraphSnapshot, mutation: SystemMutation): SystemGraphSnapshot {
  const payload = mutation.payload;
  if ((mutation.type === "add_agent" || mutation.type === "add_step") && isNodePayload(payload)) {
    const nodes = graph.nodes.some((node) => node.id === payload.id)
      ? graph.nodes
      : [...graph.nodes, payload];
    return { ...graph, nodes };
  }
  if (mutation.type === "add_step" && isEdgePayload(payload)) {
    return { ...graph, edges: appendEdge(graph.edges, payload) };
  }
  if (mutation.type === "modify_pipeline" && isPipelinePayload(payload)) {
    const removed = new Set(
      (payload.removeEdges ?? []).map((edge) => `${edge.from}:${edge.relation}:${edge.to}`),
    );
    const edges = graph.edges
      .filter((edge) => !removed.has(`${edge.from}:${edge.relation}:${edge.to}`))
      .reduce((acc, edge) => appendEdge(acc, edge), [] as SystemEdge[]);
    return {
      ...graph,
      edges: (payload.addEdges ?? []).reduce((acc, edge) => appendEdge(acc, edge), edges),
    };
  }
  if (mutation.type === "modify_agent" && isPartialNodePayload(payload)) {
    const configPatch = isRecord(payload.config) ? payload.config : {};
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === mutation.target
          ? { ...node, ...payload, config: { ...node.config, ...configPatch } }
          : node,
      ),
    };
  }
  if (mutation.type === "remove_agent") {
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === mutation.target ? { ...node, status: "inactive" } : node,
      ),
    };
  }
  if (mutation.type === "remove_step" && isEdgePayload(payload)) {
    return {
      ...graph,
      edges: graph.edges.filter(
        (edge) =>
          !(
            edge.from === payload.from &&
            edge.to === payload.to &&
            edge.relation === payload.relation
          ),
      ),
    };
  }
  return graph;
}

function appendEdge(edges: SystemEdge[], edge: SystemEdge) {
  return edges.some((item) => item.from === edge.from && item.to === edge.to && item.relation === edge.relation)
    ? edges
    : [...edges, edge];
}

function isNodePayload(value: unknown): value is SystemNode {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.type === "string";
}

function isPartialNodePayload(value: unknown): value is Partial<SystemNode> {
  return isRecord(value);
}

function isEdgePayload(value: unknown): value is SystemEdge {
  return isRecord(value) && typeof value.from === "string" && typeof value.to === "string" && typeof value.relation === "string";
}

function isPipelinePayload(value: unknown): value is PipelineMutationPayload {
  if (!isRecord(value)) return false;
  const addEdges = value.addEdges;
  const removeEdges = value.removeEdges;
  return (
    (addEdges === undefined || (Array.isArray(addEdges) && addEdges.every(isEdgePayload))) &&
    (removeEdges === undefined || (Array.isArray(removeEdges) && removeEdges.every(isEdgePayload)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMutations(value: Prisma.JsonValue): SystemMutation[] {
  return Array.isArray(value) ? (value as SystemMutation[]) : [];
}

function toGraphSnapshot(value: Prisma.JsonValue): SystemGraphSnapshot {
  if (!isRecord(value)) return { version: 0, nodes: [], edges: [] };
  return {
    version: typeof value.version === "number" ? value.version : 0,
    nodes: Array.isArray(value.nodes) ? toNodes(value.nodes) : [],
    edges: Array.isArray(value.edges) ? toEdges(value.edges) : [],
  };
}

function toNodes(value: Prisma.JsonValue): SystemNode[] {
  return Array.isArray(value) ? (value as SystemNode[]) : [];
}

function toEdges(value: Prisma.JsonValue): SystemEdge[] {
  return Array.isArray(value) ? (value as SystemEdge[]) : [];
}

function toRollbackData(value: Prisma.JsonValue | null) {
  if (!isRecord(value)) return null;
  return {
    previousGraphVersion:
      typeof value.previousGraphVersion === "number" ? value.previousGraphVersion : undefined,
  };
}

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export type SystemNode = {
  id: string;
  type: "agent" | "orchestrator" | "tool" | "policy" | "compiler";
  name: string;
  config: Record<string, unknown>;
  status: "active" | "inactive" | "experimental";
};

export type SystemEdge = {
  from: string;
  to: string;
  relation: "calls" | "depends_on" | "feeds";
};

export type SystemGraphSnapshot = {
  id?: string;
  version: number;
  nodes: SystemNode[];
  edges: SystemEdge[];
};

@Injectable()
export class SystemGraphService {
  constructor(private readonly prisma: PrismaService) {}

  async getGraph(projectId: string): Promise<SystemGraphSnapshot> {
    const graph = await this.prisma.systemGraph.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    if (!graph) return { version: 0, ...baselineGraph() };

    return {
      id: graph.id,
      version: graph.version,
      nodes: toNodes(graph.nodes),
      edges: toEdges(graph.edges),
    };
  }

  async ensureGraph(projectId: string, createdBy: string) {
    const current = await this.prisma.systemGraph.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    if (current) {
      return {
        id: current.id,
        version: current.version,
        nodes: toNodes(current.nodes),
        edges: toEdges(current.edges),
      };
    }
    return this.saveGraphVersion(projectId, createdBy, { version: 0, ...baselineGraph() });
  }

  async saveGraphVersion(projectId: string, createdBy: string, snapshot: SystemGraphSnapshot) {
    const latest = await this.prisma.systemGraph.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;

    const graph = await this.prisma.systemGraph.create({
      data: {
        projectId,
        version,
        status: "active",
        nodes: snapshot.nodes as unknown as Prisma.InputJsonValue,
        edges: snapshot.edges as unknown as Prisma.InputJsonValue,
        createdBy,
        nodeRecords: {
          create: snapshot.nodes.map((node) => ({
            projectId,
            nodeKey: node.id,
            type: node.type,
            name: node.name,
            config: node.config as Prisma.InputJsonValue,
            status: node.status,
          })),
        },
        edgeRecords: {
          create: snapshot.edges.map((edge) => ({
            projectId,
            edgeKey: `${edge.from}:${edge.relation}:${edge.to}`,
            fromNode: edge.from,
            toNode: edge.to,
            relation: edge.relation,
          })),
        },
      },
    });

    return {
      id: graph.id,
      version: graph.version,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    };
  }
}

export function baselineGraph(): Omit<SystemGraphSnapshot, "version" | "id"> {
  const nodes: SystemNode[] = [
    node("orchestrator", "orchestrator", "Orchestrator", "active"),
    node("intent_agent", "agent", "Intent Agent", "active"),
    node("decision_engine", "tool", "Decision Engine", "active"),
    node("review_board", "tool", "Review Board", "active"),
    node("strategy_selector", "tool", "Strategy Selector", "active"),
    node("patch_builder", "tool", "Patch Builder", "active"),
    node("patch_preview", "tool", "Patch Preview", "active"),
    node("evolution_engine", "tool", "Evolution Engine", "active"),
    node("system_policy", "policy", "System Policy", "active"),
  ];
  const edges: SystemEdge[] = [
    edge("orchestrator", "intent_agent"),
    edge("intent_agent", "decision_engine"),
    edge("decision_engine", "review_board"),
    edge("review_board", "strategy_selector"),
    edge("strategy_selector", "patch_builder"),
    edge("patch_builder", "patch_preview"),
    edge("patch_preview", "evolution_engine", "feeds"),
    edge("evolution_engine", "system_policy", "feeds"),
  ];
  return { nodes, edges };
}

function node(
  id: string,
  type: SystemNode["type"],
  name: string,
  status: SystemNode["status"],
): SystemNode {
  return { id, type, name, status, config: {} };
}

function edge(from: string, to: string, relation: SystemEdge["relation"] = "calls"): SystemEdge {
  return { from, to, relation };
}

function toNodes(value: Prisma.JsonValue): SystemNode[] {
  return Array.isArray(value) ? (value as SystemNode[]) : baselineGraph().nodes;
}

function toEdges(value: Prisma.JsonValue): SystemEdge[] {
  return Array.isArray(value) ? (value as SystemEdge[]) : baselineGraph().edges;
}

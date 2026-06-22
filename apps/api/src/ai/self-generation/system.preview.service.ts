import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MutationEngine, type SystemMutation } from "./mutation.engine";
import { SystemGraphService } from "./system.graph.service";

export type SystemChangeProposalView = {
  id: string;
  status: string;
  mutations: SystemMutation[];
  impactAnalysis: string[];
  riskLevel: "low" | "medium" | "high";
  previewGraph: unknown;
  createdAt: string;
  sourceTraceId?: string | null;
};

@Injectable()
export class SystemPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graphs: SystemGraphService,
    private readonly mutations: MutationEngine,
  ) {}

  async createPreview(input: {
    projectId: string;
    createdBy: string;
    mutations: SystemMutation[];
    sourceTraceId?: string;
  }): Promise<SystemChangeProposalView> {
    const current = await this.graphs.ensureGraph(input.projectId, input.createdBy);
    const previewGraph = this.mutations.previewApply(current, input.mutations);
    const riskLevel = maxRisk(input.mutations);
    const impactAnalysis = buildImpactAnalysis(input.mutations);

    const proposal = await this.prisma.systemChangeProposal.create({
      data: {
        projectId: input.projectId,
        sourceTraceId: input.sourceTraceId,
        status: riskLevel === "high" ? "blocked" : "preview",
        mutations: input.mutations as unknown as Prisma.InputJsonValue,
        impactAnalysis: impactAnalysis as Prisma.InputJsonValue,
        riskLevel,
        previewGraph: previewGraph as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });

    return {
      id: proposal.id,
      status: proposal.status,
      mutations: input.mutations,
      impactAnalysis,
      riskLevel,
      previewGraph,
      createdAt: proposal.createdAt.toISOString(),
      sourceTraceId: proposal.sourceTraceId,
    };
  }
}

function maxRisk(mutations: SystemMutation[]): "low" | "medium" | "high" {
  if (mutations.some((mutation) => mutation.riskLevel === "high")) return "high";
  if (mutations.some((mutation) => mutation.riskLevel === "medium")) return "medium";
  return "low";
}

function buildImpactAnalysis(mutations: SystemMutation[]) {
  return mutations.flatMap((mutation) => {
    if (mutation.type === "add_agent") {
      return [`新增智能体：${mutation.target}`, "影响统一编排的系统图执行计划", "需要进入系统预览"];
    }
    if (mutation.type === "add_step" || mutation.type === "modify_pipeline") {
      return [`流程变化：${mutation.target}`, "影响节点执行顺序", "需要校验依赖关系"];
    }
    return [`系统结构变化：${mutation.type} ${mutation.target}`];
  });
}

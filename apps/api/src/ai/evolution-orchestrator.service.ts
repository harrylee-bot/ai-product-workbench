import { Injectable } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import { EvolutionEngineService } from "./evolution-engine.service";
import { FeedbackAnalysisService } from "./feedback-analysis.service";
import { MultiAgentReviewService } from "./multi-agent-review.service";
import { PatchExecutionEngineService } from "./patch-execution-engine.service";
import { assertOwnerMutation, assertProjectAccess } from "./product-evolution.helpers";
import type {
  OrchestrationModuleKey,
  OrchestrationModuleState,
  OrchestrationRunItem,
  OrchestrationRunStatus,
  OrchestrationTriggerType,
} from "./product-evolution.types";

type OrchestrationRunRow = {
  id: string;
  projectId: string;
  status: string;
  triggerType: string;
  moduleStates: unknown;
  result: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type RunCycleInput = {
  projectId: string;
  triggerType?: OrchestrationTriggerType;
  eventIds?: string[];
  conversationId?: string;
  maxCycles?: number;
};

type OrchestrationCycleResult = {
  cycleNumber: number;
  insightIds: string[];
  reviewReportId: string;
  evolutionPlanId: string;
  patchExecutionId: string;
  productMemoryId?: string;
  patchResult: { success: boolean; [key: string]: unknown };
  runId?: string;
};

const MODULE_ORDER: OrchestrationModuleKey[] = [
  "semanticAnalysis",
  "multiAgentReview",
  "evolutionPlanning",
  "patchExecution",
  "memorySave",
];

@Injectable()
export class EvolutionOrchestratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feedbackAnalysis: FeedbackAnalysisService,
    private readonly multiAgentReview: MultiAgentReviewService,
    private readonly evolutionEngine: EvolutionEngineService,
    private readonly patchExecutionEngine: PatchExecutionEngineService,
  ) {}

  async runCycleForUser(user: AuthenticatedUser, input: RunCycleInput) {
    const project = await assertProjectAccess(this.prisma, user, input.projectId);
    assertOwnerMutation(user, project.ownerId, "管理员不可直接调度用户项目进化闭环");
    const maxCycles = Math.min(Math.max(input.maxCycles ?? 1, 1), 5);
    let run = await this.prisma.orchestrationRun.create({
      data: {
        projectId: input.projectId,
        status: "running",
        triggerType: input.triggerType ?? "manual",
        moduleStates: toInputJson(createModuleStates()),
        result: toInputJson({
          cycles: [],
          requestedCycles: maxCycles,
        }),
        createdBy: user.id,
      },
    });

    const cycles: OrchestrationCycleResult[] = [];
    try {
      for (let index = 0; index < maxCycles; index += 1) {
        const cycleResult = await this.runSingleCycle(user, input, index + 1, run as OrchestrationRunRow);
        cycles.push(cycleResult);
        run = await this.updateRun(run.id, {
          status: "running",
          result: {
            cycles,
            requestedCycles: maxCycles,
            latestCycle: cycleResult,
          },
        });
        if (!cycleResult.patchResult?.success) break;
      }

      const failedCycle = cycles.find((cycle) => !cycle.patchResult.success);
      run = await this.updateRun(run.id, {
        status: failedCycle ? "failed" : "completed",
        result: {
          cycles,
          requestedCycles: maxCycles,
          completedCycles: cycles.length,
          errorMessage: failedCycle ? "PATCH_EXECUTION_FAILED" : undefined,
        },
        completedAt: new Date(),
      });
      return { run: this.toItem(run as OrchestrationRunRow) };
    } catch (error) {
      run = await this.updateRun(run.id, {
        status: "failed",
        result: {
          cycles,
          requestedCycles: maxCycles,
          errorMessage: error instanceof Error ? error.message : "ORCHESTRATION_FAILED",
        },
        completedAt: new Date(),
      });
      return { run: this.toItem(run as OrchestrationRunRow) };
    }
  }

  async getRunForUser(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.orchestrationRun.findUnique({ where: { id: runId } });
    if (!run) return { run: null };
    await assertProjectAccess(this.prisma, user, (run as OrchestrationRunRow).projectId, { allowArchived: true });
    return { run: this.toItem(run as OrchestrationRunRow) };
  }

  async getStatusForUser(user: AuthenticatedUser, projectId: string) {
    await assertProjectAccess(this.prisma, user, projectId, { allowArchived: true });
    const latest = await this.prisma.orchestrationRun.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    const running = await this.prisma.orchestrationRun.findFirst({
      where: { projectId, status: "running" },
      orderBy: { createdAt: "desc" },
    });
    return {
      latestRun: latest ? this.toItem(latest as OrchestrationRunRow) : null,
      runningRun: running ? this.toItem(running as OrchestrationRunRow) : null,
    };
  }

  private async runSingleCycle(
    user: AuthenticatedUser,
    input: RunCycleInput,
    cycleNumber: number,
    run: OrchestrationRunRow,
  ): Promise<OrchestrationCycleResult> {
    const moduleStates = normalizeModuleStates(run.moduleStates);
    let activeModule: OrchestrationModuleKey | null = null;

    try {
      activeModule = "semanticAnalysis";
      await this.markModule(run.id, moduleStates, activeModule, "running", `Cycle ${cycleNumber} 正在分析显式反馈`);
      const analysis = await this.feedbackAnalysis.analyzeForUser(user, {
        projectId: input.projectId,
        eventIds: input.eventIds,
      });
      await this.markModule(
        run.id,
        moduleStates,
        activeModule,
        "completed",
        `生成 ${analysis.items.length} 条 ProductInsight`,
        analysis.items[0]?.id,
      );

      activeModule = "multiAgentReview";
      await this.markModule(run.id, moduleStates, activeModule, "running", `Cycle ${cycleNumber} 正在运行多 Agent 评审`);
      const review = await this.multiAgentReview.runForUser(user, { projectId: input.projectId });
      await this.markModule(
        run.id,
        moduleStates,
        activeModule,
        "completed",
        "生成 ProductReviewReport",
        review.reviewReport.id,
      );

      activeModule = "evolutionPlanning";
      await this.markModule(run.id, moduleStates, activeModule, "running", `Cycle ${cycleNumber} 正在生成 EvolutionPlan`);
      const evolution = await this.evolutionEngine.runForUser(user, { projectId: input.projectId });
      await this.markModule(
        run.id,
        moduleStates,
        activeModule,
        "completed",
        "生成 EvolutionPlan",
        evolution.evolutionPlan.id,
      );

      activeModule = "patchExecution";
      await this.markModule(run.id, moduleStates, activeModule, "running", `Cycle ${cycleNumber} 正在执行 Patch`);
      const patch = await this.patchExecutionEngine.applyForUser(user, {
        projectId: input.projectId,
        evolutionPlanId: evolution.evolutionPlan.id,
        conversationId: input.conversationId,
      });
      await this.markModule(
        run.id,
        moduleStates,
        activeModule,
        patch.success ? "completed" : "failed",
        patch.success ? "Patch 执行完成" : patch.errorMessage ?? "Patch 执行失败",
        patch.patchExecution.id,
      );

      activeModule = "memorySave";
      await this.markModule(
        run.id,
        moduleStates,
        activeModule,
        patch.productMemory ? "completed" : "skipped",
        patch.productMemory ? "ProductMemory 已保存" : "Patch 未产生 ProductMemory",
        patch.productMemory?.id,
      );

      return {
        cycleNumber,
        insightIds: analysis.items.map((item) => item.id),
        reviewReportId: review.reviewReport.id,
        evolutionPlanId: evolution.evolutionPlan.id,
        patchExecutionId: patch.patchExecution.id,
        productMemoryId: patch.productMemory?.id,
        patchResult: patch.patchResult,
        runId: patch.runId,
      };
    } catch (error) {
      if (activeModule) {
        await this.markModule(
          run.id,
          moduleStates,
          activeModule,
          "failed",
          error instanceof Error ? error.message : "ORCHESTRATION_MODULE_FAILED",
        );
      }
      throw error;
    }
  }

  private async markModule(
    runId: string,
    states: Record<OrchestrationModuleKey, OrchestrationModuleState>,
    key: OrchestrationModuleKey,
    status: OrchestrationModuleState["status"],
    summary?: string,
    relatedId?: string,
  ) {
    const now = new Date().toISOString();
    states[key] = {
      ...states[key],
      status,
      summary,
      relatedId,
      startedAt: states[key].startedAt ?? now,
      completedAt: ["completed", "failed", "skipped"].includes(status) ? now : undefined,
      errorMessage: status === "failed" ? summary : undefined,
    };
    await this.prisma.orchestrationRun.update({
      where: { id: runId },
      data: { moduleStates: toInputJson(states) },
    });
  }

  private async updateRun(
    runId: string,
    input: {
      status: OrchestrationRunStatus;
      result: unknown;
      completedAt?: Date;
    },
  ) {
    return this.prisma.orchestrationRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        result: toInputJson(input.result),
        completedAt: input.completedAt,
      },
    });
  }

  toItem(row: OrchestrationRunRow): OrchestrationRunItem {
    return {
      id: row.id,
      projectId: row.projectId,
      status: normalizeRunStatus(row.status),
      triggerType: normalizeTriggerType(row.triggerType),
      moduleStates: normalizeModuleStates(row.moduleStates),
      result: row.result,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString(),
    };
  }
}

function createModuleStates(): Record<OrchestrationModuleKey, OrchestrationModuleState> {
  return Object.fromEntries(
    MODULE_ORDER.map((module) => [module, { status: "pending" }]),
  ) as Record<OrchestrationModuleKey, OrchestrationModuleState>;
}

function normalizeModuleStates(value: unknown): Record<OrchestrationModuleKey, OrchestrationModuleState> {
  const base = createModuleStates();
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<OrchestrationModuleKey, OrchestrationModuleState>>
    : {};
  MODULE_ORDER.forEach((key) => {
    const state = record[key];
    if (!state) return;
    base[key] = {
      status: ["running", "completed", "failed", "skipped"].includes(state.status) ? state.status : "pending",
      startedAt: typeof state.startedAt === "string" ? state.startedAt : undefined,
      completedAt: typeof state.completedAt === "string" ? state.completedAt : undefined,
      summary: typeof state.summary === "string" ? state.summary : undefined,
      errorMessage: typeof state.errorMessage === "string" ? state.errorMessage : undefined,
      relatedId: typeof state.relatedId === "string" ? state.relatedId : undefined,
    };
  });
  return base;
}

function normalizeRunStatus(value: string): OrchestrationRunStatus {
  if (value === "completed" || value === "failed") return value;
  return "running";
}

function normalizeTriggerType(value: string): OrchestrationTriggerType {
  if (value === "event" || value === "batch" || value === "patch") return value;
  return "manual";
}

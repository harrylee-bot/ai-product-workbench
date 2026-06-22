import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DecisionTraceService, type DecisionTraceMetrics } from "./decision-trace.service";
import { PolicyUpdater } from "./policy.updater";
import { SignalGenerator } from "./signal.generator";

@Injectable()
export class EvolutionEngineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly traceService: DecisionTraceService,
    private readonly signalGenerator: SignalGenerator,
    private readonly policyUpdater: PolicyUpdater,
  ) {}

  async run(input: {
    traceId: string;
    projectId: string;
    selectedStrategyId: string;
    metrics: DecisionTraceMetrics;
    createdBy: string;
  }) {
    const outcome = this.traceService.resolveOutcome(input.metrics);
    const recentFailures = await this.prisma.decisionTrace.count({
      where: {
        projectId: input.projectId,
        selectedStrategyId: input.selectedStrategyId,
        finalOutcome: "failure",
      },
    });
    const signal = this.signalGenerator.generate({
      strategyId: input.selectedStrategyId,
      outcome,
      recentFailures,
      userFeedbackScore: input.metrics.userFeedbackScore,
    });
    const policyUpdate = await this.policyUpdater.update({
      projectId: input.projectId,
      traceId: input.traceId,
      signal,
      outcome,
      createdBy: input.createdBy,
    });

    const trace = await this.traceService.complete({
      traceId: input.traceId,
      finalOutcome: outcome,
      metrics: input.metrics,
      evolution: {
        signal,
        policyId: policyUpdate.id,
        policyVersion: policyUpdate.version,
      },
    });

    return {
      traceId: trace.id,
      finalOutcome: outcome,
      metrics: input.metrics,
      signal,
      policy: policyUpdate.policy,
      previousPolicy: policyUpdate.previousPolicy,
      policyId: policyUpdate.id,
      policyVersion: policyUpdate.version,
      strategyDelta: policyUpdate.strategyDelta,
      agentDeltas: policyUpdate.agentDeltas,
      createdAt: policyUpdate.createdAt,
    };
  }
}

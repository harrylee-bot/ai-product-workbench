import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../src/prisma/prisma.service";
import { DecisionTraceService } from "../src/ai/evolution-engine/decision-trace.service";
import { PolicyUpdater } from "../src/ai/evolution-engine/policy.updater";
import { SignalGenerator } from "../src/ai/evolution-engine/signal.generator";

describe("Phase3 evolution engine", () => {
  it("resolves outcomes and generates promotion/demotion signals", () => {
    const traceService = new DecisionTraceService({} as PrismaService);
    const signalGenerator = new SignalGenerator();

    const success = traceService.resolveOutcome({
      qaPassed: true,
      userFeedbackScore: 0.82,
      executionTime: 88,
    });
    const failure = traceService.resolveOutcome({
      qaPassed: false,
      userFeedbackScore: 0.2,
      executionTime: 120,
    });

    expect(success).toBe("success");
    expect(failure).toBe("failure");
    expect(signalGenerator.generate({
      strategyId: "strategy_a",
      outcome: success,
      recentFailures: 0,
      userFeedbackScore: 0.82,
    }).signalType).toBe("promote");
    expect(signalGenerator.generate({
      strategyId: "strategy_a",
      outcome: failure,
      recentFailures: 3,
      userFeedbackScore: 0.2,
    }).weightDelta).toBeLessThan(-0.12);
  });

  it("persists a new policy version with strategy and agent weight changes", async () => {
    const prisma = {
      systemPolicy: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "policy_1",
            createdAt: new Date("2026-06-22T00:00:00.000Z"),
            ...data,
          }),
        ),
      },
    } as unknown as PrismaService;
    const updater = new PolicyUpdater(prisma);

    const update = await updater.update({
      projectId: "project_1",
      traceId: "trace_1",
      signal: {
        strategyId: "strategy_a",
        signalType: "promote",
        weightDelta: 0.12,
        reason: "QA passed and user was satisfied.",
      },
      outcome: "success",
      createdBy: "user_1",
    });

    expect(update.version).toBe(1);
    expect(update.policy.strategyWeights.strategy_a).toBe(1.12);
    expect(update.agentDeltas.productStrategist).toBe(0.01);
    expect(update.policy.agentWeights.uxExpert).toBe(1.01);
    expect(prisma.systemPolicy.create).toHaveBeenCalledOnce();
  });
});

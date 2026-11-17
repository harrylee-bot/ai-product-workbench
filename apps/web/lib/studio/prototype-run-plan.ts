import type { Run } from "@workbench/workbench-contracts";
import type { useWorkbenchPrototypeV2Api } from "./api";

/** Resolve through authorized Plan progress, whose Run binding is explicit.
 * Runs do not expose a Plan id. Never infer it from titles or list order. */
export async function findStudioRunPlan(
  api: ReturnType<typeof useWorkbenchPrototypeV2Api>,
  run: Pick<Run, "id" | "projectId">,
) {
  const plans = await api.listPlans(run.projectId);
  for (const plan of plans) {
    const progress = await api.getProgress(run.projectId, plan.id);
    if (progress.projectId !== run.projectId || progress.planId !== plan.id)
      throw new Error("原型计划的来源不匹配，请重新读取");
    if (progress.run?.id === run.id) return plan.id;
  }
  throw new Error("当前可读取的计划中没有此运行的准确关联。请在原型任务目录中选择原计划。");
}

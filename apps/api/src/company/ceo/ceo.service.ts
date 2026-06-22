import { Injectable } from "@nestjs/common";
import type { CEOPlan, CompanyView, DepartmentType } from "../company.types";

const BUDGET_SPLIT: Record<DepartmentType, number> = {
  ceo: 0.08,
  product: 0.2,
  engineering: 0.27,
  design: 0.15,
  qa: 0.1,
  growth: 0.12,
  evolution: 0.08,
};

@Injectable()
export class CEOLayerService {
  decide(input: { marketSignal: string; company: CompanyView }): CEOPlan {
    const initiativeId = `initiative_${slug(input.marketSignal)}`;
    const budgetAllocation = Object.fromEntries(
      Object.entries(BUDGET_SPLIT).map(([department, ratio]) => [
        department,
        Math.round(input.company.budget * ratio),
      ]),
    ) as Record<DepartmentType, number>;

    return {
      approved: true,
      initiatives: [
        {
          id: initiativeId,
          name: inferProductName(input.marketSignal),
          goal: `将「${input.marketSignal}」转化为已批准、范围可衡量的产品计划。`,
          features: [
            "首席决策批准的产品章程",
            "部门负责制交付计划",
            "已分配预算的执行路径",
            "质检与增长反馈循环",
          ],
        },
      ],
      budgetAllocation,
      priority: ["product", "engineering", "design", "qa", "growth", "evolution"],
    };
  }
}

function inferProductName(input: string) {
  const text = input.trim().replace(/\s+/g, " ");
  return text.length > 28 ? `${text.slice(0, 28)}产品` : `${text || "智能产品"}运行时`;
}

function slug(value: string) {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slugged || "company_runtime";
}

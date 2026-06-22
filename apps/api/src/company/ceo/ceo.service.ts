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
  const withoutLead = text
    .replace(/^(请)?(帮我|我要|需要)?(生成|设计|创建|做)(一个|一套)?/, "")
    .trim();
  const candidate = (withoutLead || text).split(/[，,。.;；:：]/)[0]?.trim() || "智能产品";
  const shortName = candidate.length > 22 ? candidate.slice(0, 22) : candidate;
  if (/(工具|系统|平台|看板|后台|工作台|应用|小程序|网站|原型)$/.test(shortName)) {
    return shortName;
  }
  return `${shortName}方案`;
}

function slug(value: string) {
  const slugged = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slugged || "company_runtime";
}

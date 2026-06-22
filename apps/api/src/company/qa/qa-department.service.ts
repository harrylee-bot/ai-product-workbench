import { Injectable } from "@nestjs/common";
import type { CompanyQAReportView, DesignPlanView, EngineeringPlanView } from "../company.types";

@Injectable()
export class QADepartmentService {
  run(input: { engineeringPlan: EngineeringPlanView; designPlan: DesignPlanView }): CompanyQAReportView {
    const hasApis = input.engineeringPlan.apis.length >= 7;
    const hasDesign = input.designPlan.layouts.length > 0 && input.designPlan.uxFlows.length > 0;
    return {
      issues: hasApis && hasDesign ? [] : ["部门输出不完整。"],
      riskLevel: hasApis && hasDesign ? "low" : "medium",
      recommendations: [
        "每个产品计划都必须保留首席决策审批记录。",
        "执行前确认每个智能体都归属于具体部门。",
        "系统变更必须先进入预览，再允许应用。",
      ],
    };
  }
}

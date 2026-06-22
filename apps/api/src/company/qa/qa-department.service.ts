import { Injectable } from "@nestjs/common";
import type { CompanyQAReportView, DesignPlanView, EngineeringPlanView } from "../company.types";

@Injectable()
export class QADepartmentService {
  run(input: { engineeringPlan: EngineeringPlanView; designPlan: DesignPlanView }): CompanyQAReportView {
    const hasApis = input.engineeringPlan.apis.length >= 7;
    const hasDesign = input.designPlan.layouts.length > 0 && input.designPlan.uxFlows.length > 0;
    return {
      issues: hasApis && hasDesign ? [] : ["Department output is incomplete."],
      riskLevel: hasApis && hasDesign ? "low" : "medium",
      recommendations: [
        "Keep CEO approval attached to every product initiative.",
        "Verify every Agent has a departmentId before execution.",
        "Keep system mutations in preview before apply.",
      ],
    };
  }
}

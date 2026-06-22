import { Injectable } from "@nestjs/common";
import type { GrowthPlanView, ProductInitiativeView } from "../company.types";

@Injectable()
export class GrowthDepartmentService {
  optimize(input: { initiative: ProductInitiativeView }): GrowthPlanView {
    return {
      optimizations: [
        `Position ${input.initiative.name} around faster product-company execution.`,
        "Surface budget and department status as confidence signals.",
        "Promote approved product lines from dashboard to chat follow-up prompts.",
      ],
      experiments: [
        "Compare CEO-first explanation versus department timeline explanation.",
        "Test compact budget allocation labels in the preview panel.",
      ],
    };
  }
}

import { Injectable } from "@nestjs/common";
import type { CEOPlan, ProductInitiativeView } from "../company.types";

@Injectable()
export class ProductDepartmentService {
  create(input: { ceoPlan: CEOPlan; marketSignal: string }): ProductInitiativeView {
    const initiative = input.ceoPlan.initiatives[0];
    return {
      ...initiative,
      goal: `${initiative.goal} Product department converts it into PRD-ready feature modules.`,
      features: [
        ...initiative.features,
        "Workspace company dashboard",
        "Department lifecycle trace",
        "Resource allocation ledger",
      ],
    };
  }
}

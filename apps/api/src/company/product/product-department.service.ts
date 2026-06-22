import { Injectable } from "@nestjs/common";
import type { CEOPlan, ProductInitiativeView } from "../company.types";

@Injectable()
export class ProductDepartmentService {
  create(input: { ceoPlan: CEOPlan; marketSignal: string }): ProductInitiativeView {
    const initiative = input.ceoPlan.initiatives[0];
    return {
      ...initiative,
      goal: `${initiative.goal} 产品部门会将其拆解为可进入需求文档的功能模块。`,
      features: [
        ...initiative.features,
        "工作台公司看板",
        "部门生命周期追踪",
        "资源分配台账",
      ],
    };
  }
}

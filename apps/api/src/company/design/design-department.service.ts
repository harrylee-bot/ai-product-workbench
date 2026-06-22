import { Injectable } from "@nestjs/common";
import type { DesignPlanView, ProductInitiativeView } from "../company.types";

@Injectable()
export class DesignDepartmentService {
  generate(input: { initiative: ProductInitiativeView }): DesignPlanView {
    return {
      layouts: [
        "在现有右侧预览栏中展示公司看板",
        "部门预算网格",
        "产品线与生命周期状态列表",
      ],
      uxFlows: [
        `用户为「${input.initiative.name}」发送市场信号`,
        "首席决策层批准计划并分配预算",
        "各部门按顺序产出计划",
        "运行时暴露公司状态用于持续迭代",
      ],
    };
  }
}

import { Injectable } from "@nestjs/common";
import type { GrowthPlanView, ProductInitiativeView } from "../company.types";

@Injectable()
export class GrowthDepartmentService {
  optimize(input: { initiative: ProductInitiativeView }): GrowthPlanView {
    return {
      optimizations: [
        `围绕更快的产品公司执行定位「${input.initiative.name}」。`,
        "将预算和部门状态作为可信信号展示。",
        "把已批准产品线从看板延伸到对话跟进提示。",
      ],
      experiments: [
        "对比首席决策优先说明与部门时间线说明。",
        "测试预览面板中的紧凑预算分配标签。",
      ],
    };
  }
}

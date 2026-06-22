import { Injectable } from "@nestjs/common";
import type { Phase1ProductStateInput } from "../../../state/state.types";

@Injectable()
export class ProductAgent {
  run(input: { message: string }): Phase1ProductStateInput {
    const clean = input.message.trim();
    const title = clean.length > 24 ? `${clean.slice(0, 24)}...` : clean || "Phase1 产品需求";
    return {
      title,
      businessGoal: "基于用户输入生成一个可演示的产品闭环。",
      pages: [
        {
          id: "page_home",
          name: "首页",
          purpose: "承载用户核心任务",
        },
      ],
      rules: [
        {
          id: "rule_mock",
          title: "Mock AI 输出",
          description: "Phase1 所有 AI 输出均为确定性 mock JSON。",
        },
      ],
    };
  }
}

import { Injectable } from "@nestjs/common";
import type { Phase1Prd, Phase1ProductStateInput } from "../../../state/state.types";

@Injectable()
export class PrdAgent {
  run(input: { state: Phase1ProductStateInput }): Phase1Prd {
    return {
      sections: [
        {
          title: "需求背景",
          content: "mock content",
        },
        {
          title: "目标",
          content: input.state.businessGoal,
        },
        {
          title: "验收标准",
          content: "用户可以登录、创建项目、发送消息，并看到 mock PRD 与 mock Prototype。",
        },
      ],
    };
  }
}

import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ProductDesignState, RequirementDocumentDraft } from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrdWriterInput = {
  productDesignState: ProductDesignState;
  mode: "draft" | "formal";
};

@Injectable()
export class PrdWriterAgentService extends BaseAgentService<PrdWriterInput, RequirementDocumentDraft> {
  readonly agentName = AgentName.prd_writer_agent;
  readonly taskType = ModelTaskType.prd_generation;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrdWriterInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 PRD Writer Agent。只能基于 ProductDesignState 输出 PRD JSON，禁止接口、SQL、代码、技术架构细节。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrdWriterInput): RequirementDocumentDraft {
    const state = input.productDesignState;
    return {
      id: randomUUID(),
      projectId: state.projectId,
      title: `${state.title} PRD`,
      sections: [
        {
          id: "background",
          title: "1. 需求背景",
          content: state.background ?? `围绕${state.title}形成可评审产品需求。`,
          sourceStatePaths: ["background"],
        },
        {
          id: "goal",
          title: "2. 业务目标",
          content: state.businessGoal,
          sourceStatePaths: ["businessGoal"],
        },
        {
          id: "users",
          title: "3. 目标用户与使用场景",
          content: [...state.targetUsers, ...state.userScenarios].join("；"),
          sourceStatePaths: ["targetUsers", "userScenarios"],
        },
        {
          id: "scope",
          title: "4. 页面范围与功能规则",
          content: [...state.pages, ...state.features, ...state.frontendRules]
            .map((item) => String(item.name ?? item.description ?? item.purpose ?? ""))
            .filter(Boolean)
            .join("；"),
          sourceStatePaths: ["pages", "features", "frontendRules"],
        },
        {
          id: "states",
          title: "5. 状态、异常与验收标准",
          content: [...state.stateRules, ...state.exceptionScenarios, ...state.acceptanceCriteria]
            .map((item) => String(item.description ?? item.state ?? ""))
            .filter(Boolean)
            .join("；"),
          sourceStatePaths: ["stateRules", "exceptionScenarios", "acceptanceCriteria"],
        },
        {
          id: "assumptions",
          title: "6. 知识引用与 AI 推断说明",
          content: [
            ...state.knowledgeRefs.map((item) => `引用：${item.title}`),
            ...state.assumptions.map((item) => `推断：${String(item.content ?? item.description ?? "")}`),
          ].join("；"),
          sourceStatePaths: ["knowledgeRefs", "assumptions"],
        },
      ],
      knowledgeRefs: state.knowledgeRefs,
      assumptions: state.assumptions,
      validationNotes: ["PRD 已按 ProductDesignState 渲染，未包含接口、SQL 或代码实现细节。"],
    };
  }
}

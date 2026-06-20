import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type { ProductDesignState, PrototypeSpec } from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PrototypeDesignerInput = {
  productDesignState: ProductDesignState;
  targetView: "desktop" | "mobile" | "both";
  designPreference?: string;
};

@Injectable()
export class PrototypeDesignerAgentService extends BaseAgentService<
  PrototypeDesignerInput,
  PrototypeSpec
> {
  readonly agentName = AgentName.prototype_designer_agent;
  readonly taskType = ModelTaskType.prototype_design;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PrototypeDesignerInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Prototype Designer Agent。只能从 ProductDesignState 输出 PrototypeSpec JSON，组件必须带 sourceStateRef。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PrototypeDesignerInput): PrototypeSpec {
    const state = input.productDesignState;
    const page = state.pages[0] ?? { id: "page_main", name: state.title };
    const pageId = String(page.id ?? "page_main");

    return {
      id: randomUUID(),
      projectId: state.projectId,
      pages: [
        {
          id: pageId,
          name: String(page.name ?? state.title),
          layout: input.targetView === "mobile" ? "mobile_single_column" : "desktop_review_panel",
          sourceStateRef: "pages[0]",
        },
      ],
      components: [
        {
          id: "hero_summary",
          pageId,
          type: "summary_panel",
          text: state.businessGoal,
          sourceStateRef: "businessGoal",
        },
        {
          id: "primary_action",
          pageId,
          type: "button",
          text: "执行核心操作",
          states: ["default", "success", "disabled"],
          sourceStateRef: "stateRules",
        },
      ],
      states: state.stateRules.map((rule) => ({
        id: rule.id,
        name: rule.state ?? rule.id,
        sourceStateRef: "stateRules",
      })),
      interactions: [
        {
          id: "click_primary_action",
          trigger: "click",
          targetComponentId: "primary_action",
          result: "展示成功反馈或异常说明",
          sourceStateRef: "businessRules",
        },
      ],
      dialogs: [
        {
          id: "result_dialog",
          title: "操作结果",
          sourceStateRef: "exceptionScenarios",
        },
      ],
      styleGuide: {
        tone: "clean_reviewable",
        radius: 8,
        palette: ["#111827", "#0f766e", "#f8fafc", "#e5e7eb"],
      },
    };
  }
}

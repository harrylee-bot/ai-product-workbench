import { createHash } from "crypto";
import type { DecisionInput, Strategy } from "./decision.types";

export class StrategyGenerator {
  generate(input: DecisionInput): Strategy[] {
    const title = deriveTitle(input.content);
    const hash = createHash("sha1").update(`${input.intent}:${input.content}`).digest("hex").slice(0, 8);

    return [
      {
        id: `strategy_${hash}_conservative`,
        name: "conservative_fix",
        description: "保守修正当前产品状态，只补充目标和基础规则，降低执行风险。",
        impact: "low",
        patchOperations: [
          {
            op: "update",
            path: "/state/businessGoal",
            value: `围绕「${title}」补齐最小可执行目标。`,
          },
          {
            op: "add",
            path: "/state/rules/-",
            value: {
              type: "phase2_decision",
              content: "先保留现有结构，只补充必要需求规则。",
            },
          },
        ],
      },
      {
        id: `strategy_${hash}_ux`,
        name: "ux_improve",
        description: "优先改善用户体验表达，补充关键页面、交互提示和预览反馈。",
        impact: "medium",
        patchOperations: [
          {
            op: "add",
            path: "/prototype/pages/-",
            value: {
              name: "Decision Workspace",
              purpose: "展示策略、评审和预览确认状态。",
            },
          },
          {
            op: "add",
            path: "/prd/acceptanceCriteria/-",
            value: "用户可以看到至少三个策略及 Review Board 评分后再进入 Patch Preview。",
          },
        ],
      },
      {
        id: `strategy_${hash}_structure`,
        name: "structure_rewrite",
        description: "重写产品结构，将需求拆为状态、页面、规则和验收标准四类。",
        impact: "medium",
        patchOperations: [
          {
            op: "replace",
            path: "/state/pages",
            value: [
              {
                name: "Projects",
                responsibility: "项目选择和上下文定位。",
              },
              {
                name: "Decision Chat",
                responsibility: "输入需求并展示决策链路。",
              },
              {
                name: "Patch Preview",
                responsibility: "展示 before/after、diff 和风险。",
              },
            ],
          },
          {
            op: "add",
            path: "/state/rules/-",
            value: {
              type: "review_required",
              content: "所有策略必须经过 Review Board 后才能选择。",
            },
          },
        ],
      },
      {
        id: `strategy_${hash}_full`,
        name: "full_regenerate",
        description: "高影响重生成方案，重建状态骨架并为后续 PRD/Prototype 派生做准备。",
        impact: "high",
        patchOperations: [
          {
            op: "replace",
            path: "/state/title",
            value: title,
          },
          {
            op: "replace",
            path: "/state/businessGoal",
            value: `以「${title}」为核心重建产品设计状态。`,
          },
          {
            op: "replace",
            path: "/state/rules",
            value: [
              {
                type: "decision_gate",
                content: "任何产物变更必须先形成多策略决策。",
              },
              {
                type: "preview_gate",
                content: "Patch 必须先生成 Preview，确认后才允许执行。",
              },
            ],
          },
        ],
      },
    ];
  }
}

function deriveTitle(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "AI Product Workbench";
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact;
}

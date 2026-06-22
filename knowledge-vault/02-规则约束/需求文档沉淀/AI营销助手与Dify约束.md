---
title: AI营销助手与Dify约束
date: 2026-06-22
status: 已整理
source: 需求文档导入
tags:
  - 规则约束/AI营销助手
  - 规则约束/Dify
  - 导入/需求文档
---

# AI营销助手与 Dify 约束

本规则来自 AI 营销助手、案例库终端长图流程、Dify 工作流配置等资料。适用于 AI Product Workbench 后续接入知识约束、决策和 Agent 流程。

## 必须遵守

- AI 只能基于用户意图和已维护知识生成方案，不应绕过 Orchestrator 或直接改库。
- Dify/外部 AI 工作流必须明确输入 schema、输出 schema、失败兜底、超时提示和人工确认点。
- 案例库到 AI 助手的链路必须保留来源案例、所选终端、素材类型、生成过程和最终发布结果。
- 长图、海报、模板类生成必须提供预览和发布前确认，不能默认直接上线。
- 生成内容涉及营销话术、资费、权益、合规提示时，需要保留审核状态和可追溯记录。

## 推荐 Agent 输入

```json
{
  "userInput": "用户自然语言需求",
  "caseContext": "案例库/历史需求/业务域知识",
  "constraintContext": "必须遵守、优先偏好、避免和风险警告",
  "decisionContext": "多策略、评分、选中策略",
  "workflowBoundary": {
    "provider": "Dify 或 OpenAI-compatible API",
    "inputSchema": {},
    "outputSchema": {},
    "fallback": "失败时人工确认或回退到模板"
  }
}
```

## 关键场景模式

- 案例库一键复制：读取历史优秀案例，带入终端、活动类型、素材结构和业务目标。
- AI 引导办理：中间态展示执行步骤，允许收起展开，不暴露复杂工具按钮。
- 素材/长图生成：AI 负责选择模板和生成策略，用户只确认结果。
- 工作流配置：后台维护工作流地址、key、模型、超时、开关和回退策略。

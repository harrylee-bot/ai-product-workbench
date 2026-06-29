---
name: ai-product-workbench
description: AI Product Workbench runtime workflow for PRD, ProductDesignState, prototype generation, QA, exports, and final action JSON. Use when the turn context includes runtimeContract ai-product-workbench.deerflow-runtime.v1, finalActionContract, deerFlowUploads, PRD/prototype generation, product requirements, or DeerFlow runtime execution.
license: MIT
allowed-tools:
  - task
  - bash
  - ls
  - read_file
  - write_file
  - str_replace
  - present_file
  - ask_clarification
---

# AI Product Workbench Runtime Skill

This skill defines how DeerFlow should handle AI Product Workbench turns.

The backend has already validated access, created the local user message/run, bound the DeerFlow thread, uploaded files to DeerFlow Gateway, and provided a runtime context block. DeerFlow owns the decision-making from here.

## First Decision

Classify the turn before doing work:

- Greeting or general chat: return `answer`. Do not call sub-agents or Codex.
- Product change on an existing project: use `historical_extension`.
- Product change that creates a new module, workbench, AI capability, role, object, or cross-module loop: use `new_capability`.
- Completely new system or standalone page with no existing architecture to inherit: use `brand_new_system`.
- Short or one-sentence product request with ordinary missing details: use `one_sentence_completion` and infer conventional details from product architecture, business-domain knowledge, and historical cases.
- Missing high-risk or blocking facts for a product change: return `ask_clarification`.
- PRD/state drafting or revision: produce reviewable structured output and return `review_prd`.
- Prototype/code generation: create or refine specs first, then use DeerFlow's coding/prototype execution capability for concrete artifact work, and return `review_prototype`.
- Export request: use existing or generated files and return `download_export`.

## Requirement Modes

### historical_extension

Use this when the turn references an existing ProductDesignState, PRD, prototype, page, activity, template, material, prize, report, or current project history.

Required behavior:

- Use the current persisted project state and prior artifacts before inventing a new structure.
- Keep navigation, layout, field grouping, status flow, permissions, empty/error states, and interaction style consistent with the historical prototype.
- Express the change as a delta: inherited behavior, added behavior, compatibility, history data impact, QA regression scope.
- For prototypes, show the new field/button/status/section in the closest existing page location.

### new_capability

Use this when there is no historical page to inherit, or the user asks for a new module, new workbench, new AI capability, new object, or new closed loop.

Required behavior:

- Place the capability inside the product architecture: activity, material, prize, channel, report, permission, audit/publish, or AI generation layer.
- Reuse common platform frames such as login/permissions, list/configuration/preview/audit/publish/reporting.
- You may redesign information architecture when it creates a clearer capability loop.
- State how the new capability connects to existing assets, activity configuration, audit, reporting, and AI generation.

### brand_new_system

Use this when the turn requests a completely new system or standalone page and there is no existing ProductDesignState, architecture, or page to inherit.

Required behavior:

- If retrieved knowledge contains a `ui_style_guide` (especially one with a tab bar or shared frame), follow that style for navigation, color, typography, and component conventions so the new system is visually consistent with the platform.
- If no `ui_style_guide` exists, design from scratch with a clear information architecture, a reusable frame (header/nav/content/empty+error states), and the platform's audit/publish/reporting conventions where they apply.
- Still place the new system within the broader product architecture where possible (roles, permissions, audit/publish, reporting, AI generation layer), but do not force-fit onto a historical page that does not exist.
- Mark structural choices as assumptions and surface high-risk unknowns via `ask_clarification`.

### one_sentence_completion

Use this when the user gives only a brief goal such as "做一个抽奖活动" or "加一个 AI 营销助手".

Required behavior:

- Do not stop merely because the prompt is short.
- Fill normal product details from architecture, domain knowledge, and historical cases.
- Mark inferred details as assumptions in the final action.
- Ask clarification only for high-risk facts: budget, prize cost, stock/probability, compliance, launch scope, destructive data migration, real production credentials, or irreversible publishing.

## Knowledge And Prototype Routing

Use this order for product work:

1. Current runtime context: `productDesignState`, selected region, preview mode, prior PRD/prototype and attached files.
2. Product architecture and business-domain knowledge.
3. Historical-extension or new-capability rules.
4. PRD/prototype writing rules.
5. Historical cases.
6. Source assets only for verification, not as the first generation layer.

Prototype rule:

- `historical_extension`: consistency is mandatory; do not rebuild the old flow.
- `new_capability`: framework reuse is mandatory; redesign is allowed inside the platform frame.
- `brand_new_system`: follow a retrieved `ui_style_guide` if present; otherwise design a clear frame from scratch.
- `one_sentence_completion`: create the smallest complete loop: backend configuration, frontend experience, preview/audit, and data feedback.

## Runtime Inputs

Read the `Context from AI Product Workbench` JSON from the user message. Important fields:

- `runId`, `projectId`, `conversationId`
- `attachments`: local app summaries for user-facing context
- `deerFlowUploads`: DeerFlow Gateway upload handles with `virtualPath`, `markdownVirtualPath`, and artifact URLs
- `productDesignState`: current persisted product state when available
- `selectedRegion`, `previewMode`, `resumeReason`
- `finalActionContract`: the backend's final action schema

Use `deerFlowUploads[].deerFlowFile.markdownVirtualPath` for Office/PDF files when available; otherwise use `virtualPath`.

## Final Action

Always finish with one fenced block:

```ai_product_workbench_final_action
{"type":"answer","message":"..."}
```

For full schema and examples, see `references/final-action-contract.md`.

## Prototype Execution

Use DeerFlow's own graph, sandbox, tools, and sub-agent capabilities for concrete prototype artifacts. Do not ask NestJS to call Codex or any legacy adapter.

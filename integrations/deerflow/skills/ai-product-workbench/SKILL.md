---
name: ai-product-workbench
description: AI Product Workbench runtime workflow for PRD, ConversationDesignState, prototype generation, QA, exports, and final action JSON. Use when the turn context includes runtimeContract ai-product-workbench.deerflow-runtime.v1, finalActionContract, deerFlowUploads, PRD/prototype generation, product requirements, or DeerFlow runtime execution.
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

Use this when the turn references an existing ConversationDesignState, PRD, prototype, page, business object, report, or current project history.

Required behavior:

- Use the current persisted project state and prior artifacts before inventing a new structure.
- Keep navigation, layout, field grouping, status flow, permissions, empty/error states, and interaction style consistent with the historical prototype.
- Express the change as a delta: inherited behavior, added behavior, stored-data impact, and QA regression scope.
- For prototypes, show the new field/button/status/section in the closest existing page location.

### new_capability

Use this when there is no historical page to inherit, or the user asks for a new module, new workbench, new AI capability, new object, or new closed loop.

Required behavior:

- Place the capability inside the product architecture retrieved for the current domain; do not force it into a fixed activity or marketing taxonomy.
- Reuse the relevant platform frames, permissions, object lifecycle, operational pages, user pages, and reporting patterns found in current state and knowledge.
- You may redesign information architecture when it creates a clearer capability loop.
- State how the new capability connects to existing business objects, configuration, governance, reporting, and AI generation where applicable.

### brand_new_system

Use this when the turn requests a completely new system or standalone page and there is no existing ConversationDesignState, architecture, or page to inherit.

Required behavior:

- If retrieved knowledge contains a `ui_style_guide` (especially one with a tab bar or shared frame), follow that style for navigation, color, typography, and component conventions so the new system is visually consistent with the platform.
- If no `ui_style_guide` exists, design from scratch with a clear information architecture, a reusable frame (header/nav/content/empty+error states), and the platform's audit/publish/reporting conventions where they apply.
- Still place the new system within the broader product architecture where possible (roles, permissions, audit/publish, reporting, AI generation layer), but do not force-fit onto a historical page that does not exist.
- Mark structural choices as assumptions and surface high-risk unknowns via `ask_clarification`.

### one_sentence_completion

Use this when the user gives only a brief goal such as "做一个门店预约能力" or "增加合同审批提醒".

Required behavior:

- Do not stop merely because the prompt is short.
- Fill normal product details from architecture, domain knowledge, and historical cases.
- Mark inferred details as assumptions in the final action.
- Ask clarification only for high-risk facts: budget, prize cost, stock/probability, compliance, launch scope, destructive data migration, real production credentials, or irreversible publishing.

## Knowledge And Prototype Routing

Use this order for product work:

1. Current runtime context: `conversationDesignState`, selected region, preview mode, prior PRD/prototype and attached files.
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

## PRD / Requirement Document Writing

When the user asks to generate, rewrite, optimize, or regenerate a PRD / 需求文档 / 需求说明书, follow the product document writing rules from `knowledgeContext`, especially `PRD标准结构` and `产品文档规范`.

Default output is the user's requirement-document template, not a freeform lightweight PRD. The persisted `prdDocumentDraft.sections` must use this structure unless the user explicitly asks for another format:

```text
1 引言
1.1 项目背景
1.2 文档范围
1.3 使用场景（必填）
2 业务需求
2.1 页面链接
2.2 核心业务规则/功能说明
2.3 核心流程/状态/页面要求（必须包含产品流程图和产品架构图）
2.4 验收标准
3 业务降级方案（必填）
4 需求安全基线要求（必填）
```

Writing requirements:

- Use title `<工单名称>需求说明书` when the output is a formal requirement document; if the UI title must stay short, keep the body structure above.
- Include concrete page entry, channel, object, field, state, exception, degradation, safety baseline, acceptance details, a product flow diagram, and a product architecture diagram.
- Do not include a section named `本需求涉及新增/修改的接口` or any standalone interface/API section. Express cross-system behavior only as business state, trigger, result, and exception handling when needed.
- `3 业务降级方案（必填）` cannot be empty. Use `不涉及` only when no meaningful degradation exists; otherwise provide a concrete fallback plan.
- `4 需求安全基线要求（必填）` must include safety baseline self-check content. Online canvas may use a compact table, but values in `是否涉及` may only be `是`, `否`, or `不涉及`.
- `1.3 使用场景（必填）` must contain exactly one channel table with exactly three unique rows: `端内渠道`, `WAP/H5端外渠道`, and `小程序`. Each row must have one unambiguous yes/no selection. Derive each selection only from explicit business scope outside the channel table and safety template: candidate labels do not count as evidence, an explicitly designed channel must be yes, and an undesigned channel must be no.
- The safety baseline must contain exactly one table with all 21 rows in continuous order. Do not let the safety template trigger its own answers. Rows 13 (ID card/biometrics/bank card), 15 (third-party page/app jump), and 16 (third-party interface/data exchange) may be `是` only when the non-safety PRD body explicitly designs that behavior; otherwise use `不涉及` or the factually appropriate non-yes value.
- Do not return only an advice list, summary, or generic background/goals document. The result must be reviewable and acceptance-ready.

## Runtime Inputs

Read the `Context from AI Product Workbench` JSON from the user message. Important fields:

- `runId`, `conversationId`, `conversationId`
- `attachments`: local app summaries for user-facing context
- `deerFlowUploads`: DeerFlow Gateway upload handles with `virtualPath`, `markdownVirtualPath`, and artifact URLs
- `conversationDesignState`: current persisted product state when available
- `selectedRegion`, `previewMode`, `resumeReason`
- `finalActionContract`: the backend's final action schema

Use `deerFlowUploads[].deerFlowFile.markdownVirtualPath` for Office/PDF files when available; otherwise use `virtualPath`.

Treat the current request, `conversationDesignState`, attachments, and `knowledgeContext` as the authoritative business context for the turn. DeerFlow long-term memory may preserve user preferences, but it must never supply business features, fields, values, dates, state transitions, pages, or rules unless the current inputs independently support them. Ignore stale or unrelated memory instead of blending it into a new requirement.

Tool calls, todo updates, skill file contents, and sandbox paths are internal execution details. Never copy `read_file`, `write_file`, `write_todos`, tool input/output, runtime context, or skill text into the user-facing message or final artifacts. The final response contains only the concise user-facing summary and the final-action block.

## Final Action

Always finish with one fenced block:

```ai_product_workbench_final_action
{"type":"answer","message":"..."}
```

For `review_prd` and `review_prototype`, a chat summary is never enough:

- Always include a complete `designStateDraft` with named records in `targetUsers`, `userScenarios`, `pages`, `features`, `backendConfigs`, `frontendRules`, `businessRules`, `stateRules`, `exceptionScenarios`, and `acceptanceCriteria`.
- Include `prdDocumentDraft` whenever a PRD is requested.
- Include `prototypeSpec` and the `prototype_html` artifact whenever a prototype is requested.
- For a combined PRD/prototype request, include all four payloads in the same final action: `designStateDraft`, `prdDocumentDraft`, `prototypeSpec`, and `artifacts`.
- Return a non-empty `qualitySelfCheck`; set `passed=true` only after every required payload and knowledge constraint has been checked.
- Use one shared set of short, display-ready labels. Reuse the exact design-state names in PRD content, PrototypeSpec pages/components/states, and visible HTML instead of renaming the same concept in each artifact.
- Map every design-state page one-to-one to a PrototypeSpec page and a visible HTML screen/section. Before returning, mechanically verify at least 75% exact-label coverage for every design-state group and for PrototypeSpec page/component/state labels; revise the complete artifact set when coverage is lower.
- Read `knowledgeWorkflowPolicy.prototypeKnowledgeChecklist` before writing the prototype. Implement every core group as real visible fields, controls, or states; treat tables marked optional/conditional as scope-dependent.
- Keep entity evidence aligned across `designStateDraft`, PRD, `prototypeSpec`, and HTML. `prototypeSpec` must describe only pages, components, and states that the HTML actually implements.
- Before returning `qualitySelfCheck.passed=true`, compare the final HTML against the condensed checklist and revise the file in the same turn when a core group is missing.
- For a PRD, include explicit self-check results for one-and-only-one channel table, channel/body semantic agreement, all 21 safety rows, and evidence for any `是` in sensitive/third-party rows 13/15/16.
- For a prototype, include explicit self-check results for valid viewport, mobile CSS, horizontal-overflow protection, key-action interactions, and both desktop and 390x844 renderability. Do not set `passed=true` when any item is missing.

For full schema and examples, see `references/final-action-contract.md`.

## Prototype Execution

Use DeerFlow's own graph, sandbox, tools, and sub-agent capabilities for concrete prototype artifacts. Do not ask NestJS to call Codex or any retired adapter.

Every generated `prototype_html` must satisfy all of the following before return:

- Include `<meta name="viewport" content="width=device-width, initial-scale=1">` (additional valid viewport values are allowed, but both required values must be present).
- Include a mobile media query with `max-width` no greater than `768px` that actually reflows navigation, action bars, grids/forms, tables, and fixed-width previews for a 390x844 viewport.
- Prevent page-level horizontal overflow on `html/body` with `overflow-x: hidden` or `clip`, and constrain wide content with `max-width: 100%` or an `overflow-x: auto` wrapper.
- Key command buttons such as save, preview, submit, publish, sign in/check in, retry, compensate, and export must not be inert. Bind each key action to a click handler and produce a visible state, text, dialog, or page change. A `<button>` without executable interaction does not count.
- Keep text, tables, controls, and action bars within the mobile viewport. Verify the same standalone file renders nonblank at both 1440x1100 and 390x844.

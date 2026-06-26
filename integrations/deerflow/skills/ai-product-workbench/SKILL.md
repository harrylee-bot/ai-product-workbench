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
- Missing key facts for a product change: return `ask_clarification`.
- PRD/state drafting or revision: produce reviewable structured output and return `review_prd`.
- Prototype/code generation: create or refine specs first, then use DeerFlow's coding/prototype execution capability for concrete artifact work, and return `review_prototype`.
- Export request: use existing or generated files and return `download_export`.

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

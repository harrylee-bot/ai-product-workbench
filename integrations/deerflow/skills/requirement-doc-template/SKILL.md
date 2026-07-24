---
name: requirement-doc-template
description: Create, supplement, review, or rewrite Chinese product/business requirement documents in the user's fixed Word format and quality standard. Use for 需求文档/需求说明书/PRD work that requires fixed sections, one channel table, product flow and architecture diagrams, a degradation plan, a semantically correct 21-row safety baseline, acceptance-ready content, and final DOCX validation.
---

# Requirement Doc Template

Use this skill to produce Chinese requirement documents that match the user's standard Word template and pass the baseline quality rules.

## Required Resources

- Use `assets/requirement-template.docx` as the canonical Word style and structure reference. It is based on the user's H5 domain example and carries the expected page setup, styles, history table, TOC page, channel table, and 21-row safety baseline table.
- Read `references/structure.md` before drafting or editing a document.
- Read `references/quality-standards.md` before drafting, supplementing, or reviewing content.
- Run `scripts/docx_quality_check.py` on every final DOCX before delivery. Use `--allow-template-placeholders` only when checking the bundled template itself, never for a final user deliverable.

## Workflow

1. Determine the requirement/work-order name. The file name and cover title must be `<工单名称>需求说明书`; do not invent a different cover name.
2. Gather the raw requirement, target system, channels, entry path, changed pages, actors, permission rules, business flow, acceptance conditions, degradation behavior, and output location from the user message and attached files.
3. If information is missing, make conservative assumptions only when the business meaning remains clear. Keep unresolved implementation details in assumptions or delivery metadata, not in the PRD body. Do not use `待确认`, `以实际为准`, `以实际上线地址为准`, or similar placeholder wording in the final document.
4. Start from a copy of `assets/requirement-template.docx`. Preserve the template page setup, margins, styles, page breaks, version history table, TOC page, channel table, and safety baseline table. If rebuilding is unavoidable, replicate those elements from the template.
5. Remove all template-only reminders, examples, placeholder links, and `更新此内容/删除此内容` notes from the final deliverable.
6. Preserve the standard section order:
   - Cover
   - Version history
   - Manual table of contents
   - 1 引言（1.1 项目背景、1.2 文档范围、1.3 使用场景（必填））
   - 2 业务需求（2.1 页面链接、2.2 核心业务规则/功能说明、2.3 核心流程/状态/页面要求、2.4 验收标准）
   - 3 业务降级方案（必填）
   - 4 需求安全基线要求（必填）
7. Add both a product flow diagram and a product architecture diagram under `2.3 核心流程/状态/页面要求`. Explain how each diagram maps to the requirement. Use business/product concepts rather than API names or implementation internals.
8. Write content that supports test case design: explain the system/channel, current state, reason for change, changed module, specific operations, trigger conditions, expected result, exception handling, and acceptance-ready criteria.
9. Fill the degradation plan. If it truly does not apply, the body under the heading must contain only `不涉及`. If it applies, write a concrete fallback plan of at least 100 Chinese characters.
10. Fill the 21-row safety baseline table. The `是否涉及` column may contain only `是`, `否`, or `不涉及`; add a remarks column only when extra explanation is necessary.
11. Keep exactly one channel table. Determine selected channels from explicit requirement facts; a candidate channel name, a disabled option, or the safety-template wording is never evidence that the channel is enabled.
12. Derive safety-baseline values only from requirement facts outside the safety table. Any requested construction, development, implementation, modification, or upgrade of a function, page, control, flow, state behavior, or business capability makes row 1 `是`. Row 1 never uses `否`; when it is `是`, its remarks must name the concrete changed function, page, interface, or logic. Use `不涉及` only when the requirement body explicitly states there is no function, page, interface, or logic change. Reusing or not adding a default, setting, field, status, or category only narrows scope and is not global no-change evidence. Sensitive collection, app/mini-program, third-party jump, third-party data exchange, and storage rows remain `不涉及` unless the requirement explicitly includes them. Generic labels such as `端内渠道`, `客户端`, `消费者端`, or `前端` do not prove that the business loads into an APP or mini-program; a disabled or excluded APP/mini-program is negative evidence. Only a source-backed affirmative APP or mini-program fact can activate that safety row.
13. Run the DOCX quality checker and fix all errors. Then render or visually inspect the final DOCX pages when tooling is available, especially page breaks, table wrapping, screenshots, diagrams, and safety table readability.

## Output Rules

- Deliver the final `.docx` path only unless the user asks for intermediate files.
- Name the file with the requirement title, for example `需求标题.docx` or `需求标题需求说明书.docx`.
- Keep the manual TOC text aligned with the actual section names. Exact page numbers may be approximate unless Word field updating is explicitly requested, but the TOC must not contain deleted headings.
- Keep `不涉及` for degradation plan only when the user or context clearly indicates no fallback is needed; otherwise write concrete fallback behavior.
- Keep the safety baseline table in the standard 21-row form and adjust `是否涉及` values based on the actual requirement.

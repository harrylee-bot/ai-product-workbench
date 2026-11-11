---
name: requirement-doc-template
description: Create, supplement, review, or rewrite Chinese product/business requirement documents in the user's H5-example Word structure and black-and-white style. Use for 需求文档/需求说明书/PRD work that requires function-specific business sections, one channel table, diagrams selected by requirement scale and explanatory need, a degradation plan, a semantically correct 21-row safety baseline, acceptance-ready content, and final DOCX validation.
---

# Requirement Doc Template

Use this skill to produce Chinese requirement documents that match the user's standard Word template and pass the baseline quality rules.

## Required Resources

- Use `assets/requirement-template.docx` as the canonical Word style and structure reference. It is based on the user's H5 domain example and carries the expected page setup, styles, history table, TOC page, channel table, and 21-row safety baseline table. The bundled copy uses black text and white, black-bordered tables as requested; the user's original reference file remains unchanged.
- Read `references/structure.md` before drafting or editing a document.
- Read `references/quality-standards.md` before drafting, supplementing, or reviewing content.
- Run `scripts/docx_quality_check.py` on every final DOCX before delivery. Use `--allow-template-placeholders` only when checking the bundled template itself, never for a final user deliverable.

## Workflow

1. Determine the requirement/work-order name. The file name and cover title must be `<工单名称>需求说明书`; do not invent a different cover name.
2. Gather the raw requirement, target system, channels, entry path, changed pages, actors, permission rules, business flow, acceptance conditions, degradation behavior, and output location from the user message and attached files.
3. If information is missing, make conservative assumptions only when the business meaning remains clear. Keep unresolved implementation details in assumptions or delivery metadata, not in the PRD body. Do not use `待确认`, `以实际为准`, `以实际上线地址为准`, or similar placeholder wording in the final document.
4. Start from a copy of `assets/requirement-template.docx`. Preserve the H5 example's page setup, heading levels, separate cover/history/TOC pages, and table purposes. Use black text for the cover, headings, body, hyperlinks, captions, headers, footers, and tables, with white table backgrounds and black borders. Remove template color accents and highlighting. Screenshots, logos, and other supplied images retain their original colors unless the user requests otherwise. Check grid, spacing, wrapping, and page breaks so template layout defects are not copied into the result.
5. Remove all template-only reminders, examples, placeholder links, and `更新此内容/删除此内容` notes from the final deliverable.
6. Preserve the standard section order:
   - Cover
   - Version history
   - Manual table of contents
   - 1 引言（1.1 项目背景、1.2 文档范围、1.3 使用场景（必填））
   - 2 业务需求（2.1 页面链接；从 2.2 起按本次具体功能或业务规则逐节命名，连续编号；流程/页面要求、验收和新增/修改接口等内容按需嵌入功能节或另设后续小节）
   - 3 业务降级方案（必填）
   - 4 需求安全基线要求（必填）
7. Independently decide whether a product flow diagram and a product architecture diagram improve this requirement, using the criteria in `references/structure.md`. Consider scope, actors, branches, state changes, and module relationships; do not use document length or the number of collected items alone. Choose neither, either one, or both without asking the user to make this routine choice. Respect explicit user or delivery requirements. Place any diagram in its related functional section or an optional later flow/product-structure section; never reserve a fixed `2.3` for it. When no diagram is needed, explain relevant steps, state conditions, and page rules in the functional sections using text or tables. For each included diagram, use product/business concepts and explain its relationship to the requirement.
8. Write content that supports test case design: explain the system/channel, current state, reason for change, changed module, specific operations, trigger conditions, expected result, exception handling, and acceptance-ready criteria. Follow the H5 example by naming business subsections after actual functions; do not copy the example's business facts or force generic `2.2/2.3/2.4` titles. Interface impact may be described in an optional subsection when supported by this requirement; do not invent routes or expand a product PRD into a technical interface contract.
9. Fill the degradation plan. If it truly does not apply, the body under the heading must contain only `不涉及`. If it applies, write a concrete fallback plan of at least 100 Chinese characters.
10. Fill the 21-row safety baseline table. The `是否涉及` column may contain only `是`, `否`, or `不涉及`; add a remarks column only when extra explanation is necessary.
11. Keep exactly one channel table. Determine selected channels from explicit requirement facts; a candidate channel name, a disabled option, or the safety-template wording is never evidence that the channel is enabled.
12. Derive safety-baseline values only from requirement facts outside the safety table. Any requested construction, development, implementation, modification, or upgrade of a function, page, control, flow, state behavior, or business capability makes row 1 `是`. Row 1 never uses `否`; when it is `是`, its remarks must name the concrete changed function, page, interface, or logic. Use `不涉及` only when the requirement body explicitly states there is no function, page, interface, or logic change. Reusing or not adding a default, setting, field, status, or category only narrows scope and is not global no-change evidence. Sensitive collection, app/mini-program, third-party jump, third-party data exchange, and storage rows remain `不涉及` unless the requirement explicitly includes them. Preserve generic labels such as `端内渠道`, `客户端`, `消费者端`, or `前端` literally; never expand them into an affirmative APP or mini-program loading, publication, operation, or enabled-surface claim. Preserve explicit negative or excluded APP/mini-program facts verbatim. Candidate-authored prose and `channel:inApp` are not source evidence; every Runtime `targetSurface` value, including `app` and `web`, is not source evidence and cannot activate row 12. Only an affirmative APP or mini-program fact from the user or an authorized source can activate row 12; without one, use `不涉及` with no remarks.
13. Run the DOCX quality checker and fix all errors. Then render or visually inspect the final DOCX pages when tooling is available, especially page breaks, table wrapping, screenshots, diagrams, and safety table readability.

## Output Rules

- Deliver the final `.docx` path only unless the user asks for intermediate files.
- Name the file with the requirement title, for example `需求标题.docx` or `需求标题需求说明书.docx`.
- Keep the manual TOC text aligned with the actual section names. Exact page numbers may be approximate unless Word field updating is explicitly requested, but the TOC must not contain deleted headings.
- Keep `不涉及` for degradation plan only when the user or context clearly indicates no fallback is needed; otherwise write concrete fallback behavior.
- Keep the safety baseline table in the standard 21-row form and adjust `是否涉及` values based on the actual requirement.

# Requirement Document Quality Standards

Use this reference before drafting, supplementing, or reviewing a requirement document. These rules are extracted from the user's `规范要求.xls`; apply the requirement-document rules, not the design-document-only rules, unless the user explicitly asks for a design document.

## Naming And Pages

- The final file name, work-order name, and cover title must match. Use `<工单名称>需求说明书`.
- The version history must be on its own page and must include author and date.
- The TOC must be on its own page. TOC headings must match the body headings after edits.
- Upload/submission timing is outside document generation, but the final output should be ready for the requirement baseline attachment list.

## Style And Chapter Structure

- Use black editable text throughout, white table backgrounds, and black table borders. Remove colored heading accents, hyperlink colors, striped fills, and highlighting; distinguish levels by size, weight, and spacing. Supplied screenshots and logos keep their original colors unless requested otherwise.
- Follow the H5 example: cover, separate version-history page, separate TOC page, `1 引言` with `1.1–1.3`, `2 业务需求`, `3 业务降级方案（必填）`, and `4 需求安全基线要求（必填）`.
- In chapter 2 keep `2.1 页面链接`, then number actual functional or business-rule sections from `2.2` onward. Do not require fixed generic `2.2/2.3/2.4` names. Flow, page/state, acceptance, and interface-impact content may be embedded in related functional sections or added as later subsections when needed.
- Allow an evidence-based新增/修改接口 subsection as in the H5 example; do not invent interfaces or require a technical contract to fill it. Omit it when irrelevant.

## Required Content Quality

- Include clear requirement background and concrete execution details that support test-case writing.
- State the system/software/channel, current state, reason for change, changed module, target function, and expected purpose.
- Keep background and requirement description related but not duplicated.
- Do not copy the same body text under multiple headings.
- Do not leave any heading without content. If a heading is irrelevant, delete both the heading and its template body.
- Remove template reminders, examples, and placeholder content before final delivery.
- Do not use `待确认`, `以实际为准`, `以实际上线地址为准`, or similar placeholders in the PRD body. Put unresolved details in assumptions or delivery metadata.
- Do not paste links as a replacement for concrete requirements. If a route/link is needed, still describe the required behavior in text.
- Do not write only `与XX逻辑相同` or `在XXX基础上`. Spell out the inherited or changed logic.
- If a diagram is included, add text that explains how the diagram relates to this requirement.
- Independently assess the need for `产品流程图` and `产品架构图` using `structure.md`; neither, either one, or both may be appropriate. Do not fail a document solely because a diagram type or a standalone flow section is absent. Related functional sections must still explain relevant steps, states, and page rules in text or tables.
- Acceptance criteria are required content; an independently titled or fixed-numbered acceptance section is not required.
- Review included diagrams for actual explanatory value, consistency with the requirement, legibility, and adjacent explanatory text. Follow explicit user or delivery requirements for mandatory diagrams; routine automated checks do not infer these requirements from document length or item count.
- Keep exactly one channel table and ensure its selected channels agree with the surrounding requirement text.

## Page Or Capability Details

- For front-end or back-end page changes, state how to enter the target page and exactly what content, controls, or behavior changes on that page.
- For table or field-value changes, state the table/object, trigger condition/timing, target field, and target value.

## Degradation Plan

- The `业务降级方案（必填）` section must be filled.
- If degradation truly does not apply, delete template body text and write only `不涉及`.
- If degradation applies, delete template body text and write a concrete degradation/fallback plan of at least 100 Chinese characters.

## Safety Baseline

- The `需求安全基线要求（必填）` section must be filled.
- Keep the standard 21-row safety baseline table.
- In the `是否涉及` column, write only `是`, `否`, or `不涉及`.
- If special explanation is needed, add a remarks column instead of putting explanatory text in `是否涉及`.
- Determine each value from explicit requirement facts outside the safety table. Rows for app/mini-program, ID/bank/biometric collection, third-party jump, third-party exchange, and data storage must remain `不涉及` without explicit evidence.
- Any requested construction, development, implementation, modification, or upgrade of a function, page, control, flow, state behavior, or business capability makes row 1 `是`. Row 1 never uses `否`; when it is `是`, its remarks must name the concrete changed function, page, interface, or logic. Row 1 may be `不涉及` only when the requirement body explicitly states there is no function, page, interface, or logic change. Reusing or not adding a default, setting, field, status, or category only narrows scope and is not global no-change evidence.

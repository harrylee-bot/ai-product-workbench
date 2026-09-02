# Requirement Document Quality Standards

Use this reference before drafting, supplementing, or reviewing a requirement document. These rules are extracted from the user's `规范要求.xls`; apply the requirement-document rules, not the design-document-only rules, unless the user explicitly asks for a design document.

## Naming And Pages

- The final file name, work-order name, and cover title must match. Use `<工单名称>需求说明书`.
- The version history must be on its own page and must include author and date.
- The TOC must be on its own page. TOC headings must match the body headings after edits.
- Upload/submission timing is outside document generation, but the final output should be ready for the requirement baseline attachment list.

## Required Content Quality

- Include clear requirement background and concrete execution details that support test-case writing.
- The requirement subject and requested business change must come from the user, an authorized project source, or an attachment. Never invent them merely because the user selected PRD as the output kind.
- State the system/software/channel, current state, reason for change, changed module, target function, and expected purpose.
- Keep background and requirement description related but not duplicated.
- Do not copy the same body text under multiple headings.
- Do not leave any heading without content. If a heading is irrelevant, delete both the heading and its template body.
- Remove template reminders, examples, and placeholder content before final delivery.
- Do not use `待确认`, `以实际为准`, `以实际上线地址为准`, or similar placeholders in the PRD body. Put unresolved details in assumptions or delivery metadata.
- Do not paste links as a replacement for concrete requirements. If a route/link is needed, still describe the required behavior in text.
- Do not write only `与XX逻辑相同` or `在XXX基础上`. Spell out the inherited or changed logic.
- If a diagram is included, add text that explains how the diagram relates to this requirement.
- Keep the fixed `2.1` through `2.4` sections and include both `产品流程图` and `产品架构图` in `2.3`.
- Keep exactly one channel table and ensure its selected channels agree with the surrounding requirement text.
- Acceptance results must be observable. Do not use `正常展示`, `友好提示`, `流转顺畅`, `正确显示结果`, `符合预期`, `满足要求`, or a generic promise to improve efficiency/quality as a substitute for an exact result.

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

# Requirement Document Quality Standards

Apply these gates before publishing or submitting a PRD candidate.

## Naming And Structure

- Artifact title, document title, cover title, and work-order name are consistent: `<工单名称>需求说明书`.
- Cover, version history, manual table of contents, and fixed sections 1 through 4 are present and ordered.
- Every heading has substantive content. No deleted heading remains in the table of contents.
- Exactly one typed channel table, one product-flow diagram, one product-architecture diagram, one degradation section, and one complete 21-row safety table exist.

## Acceptance-Ready Content

- Background names the product/system/channel, current state, reason, changed module, target function, and purpose.
- Page changes state the entry and exact visible controls, content, rules, and behavior.
- Field or state changes name the object, trigger/timing, target field/state, and expected value/result.
- Permission rules, success state, empty state, failure state, retry, duplicate prevention, and recovery are explicit when relevant.
- Acceptance rows can be converted directly into test cases and do not merely restate the feature name.
- Background and requirement details are related but not copied verbatim across sections.

## Forbidden Output

- No `待确认`, `以实际为准`, `以实际上线地址为准`, template reminders, placeholder links, or sample business content.
- No requirement that says only `与XX逻辑相同` or `在XXX基础上`; spell out inherited and changed behavior.
- No raw link in place of requirements.
- No standalone interface/API chapter.
- No generic advice list, product summary, or nine-section lightweight PRD substituted for the fixed requirement document.

## Degradation

- Applicable degradation has at least 100 Chinese characters and concrete user-visible fallback, retained data, retry/recovery, idempotency, and reconciliation behavior.
- Non-applicable degradation contains only `不涉及`.

## Safety Baseline

- All 21 rows are present in canonical sequence.
- `applicability` contains only `是`, `否`, or `不涉及`.
- Remarks do not leak into `applicability`.
- Every `是` or `否` is supported by a fact elsewhere in the requirement. Safety row wording cannot be used as its own evidence.

## Runtime Publication

1. Start from `../prd-runtime-result.example.json` and replace all sample IDs and content.
2. Check fixed structure, references, diagrams, channel row order, degradation length, safety sequence, placeholders, and Artifact/content citation equality.
3. Publish the complete renderable candidate through `workbench_artifact_draft_publish`.
4. Submit the identical candidate through `workbench_runtime_result_submit` and fix every validator issue until `ok:true`.

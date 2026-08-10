# Runtime Result Contract

Every complete `workbench.runtime.result.v1` object must pass through the trusted `workbench_runtime_result_submit` tool before persistence. In an exact Prototype-only create Run (`requestedArtifactKinds` is exactly `["prototype"]` and the Artifact operation is `create`), the DeerFlow lead does not call that tool directly: after all four Prototype stages, publish one complete terminal Draft at `artifact_index: 0`; the trusted Runtime converts that normalized Draft into the Result tool call and stops after validation succeeds. If that automatic Result reports validation issues, keep the successful Draft immutable, repair only the reported paths in one complete candidate, and continue through manual Result validation; the Runtime does not repeat automatic submission. For every other Runtime path, the DeerFlow lead must submit the complete result through `workbench_runtime_result_submit`. 产品工作台 accepts only the current turn's successful ToolMessage artifact and validates it again before persistence. Never emit a `workbench_runtime_result` Markdown fence or raw result JSON in assistant prose.

## Message Only

Use this only when no Artifact was requested.

```json
{
  "protocol": "workbench.runtime.result.v1",
  "message": "可以，请继续描述要完成的产品需求。",
  "artifacts": []
}
```

## Create An Artifact

`generate`, `redesign`, and `ideate` Runs create new Artifacts. Every kind listed in `requestedArtifactKinds` must be present.

A `generate` Run may include `artifactTargets` only when `requestedArtifactKinds` includes `prototype`. Every such target has non-empty `screenIds` selecting verified source Prototype Screens. The target snapshot is read-only inspiration/context, not an edit grant: do not echo it in a `revise` operation or mutate its source Artifact/version. A `redesign` or `ideate` Run never includes targets.

Target Prototype snapshots may include `assets` containing verified binary metadata and a DeerFlow `handle`. Use only that handle to read the source binary, and preserve the verified blob/media/checksum metadata when reusing it in a new Prototype. The asset is not a Run source: do not place it in `sources` or `deerFlowUploads`, and never infer a local path or `storageKey`.

```json
{
  "protocol": "workbench.runtime.result.v1",
  "message": "调研记录已生成。",
  "artifacts": [
    {
      "kind": "document",
      "schemaVersion": 1,
      "title": "调研记录",
      "operation": { "kind": "create" },
      "citations": [],
      "content": { "text": "完整调研内容" }
    }
  ]
}
```

PRD and Prototype content must satisfy the complete schemas in `runtime-result.schema.json`; do not substitute free-form Markdown or an abbreviated object. Prototype `variables` and state `values` are explicit runtime data sources: every variable/state binding must resolve to one of them, and binding node/value types must match the schema. Forms, submit/reset button types, submit ownership, and select options are explicit IR fields; do not rely on renderer inference.

Prototype layout enums use Workbench spellings, not CSS spellings. For
`layout.justify`, use exactly `start`, `center`, `end`, `spaceBetween`, or
`spaceAround`; for `layout.align`, use exactly `start`, `center`, `end`, or
`stretch`. Never emit CSS aliases such as `space-between`, `space-around`,
`flex-start`, or `flex-end`.

### PRD authoring fast path

Use `prd-runtime-result.schema.json` as the business-neutral transport shape after reading the installed `requirement-doc-template` skill and its canonical references. New PRDs use Artifact schemaVersion 2 and `workbench.prd.v2`; v1 exists only for compatibility with older Artifacts. Populate the cover, version history, manual table of contents, fixed sections, typed channel table, both product diagrams, degradation plan, 21-row safety baseline, typed inline content, and valid bidirectional goal/requirement/acceptance/flow references only from the current request and authorized sources. Never use a filled PRD business example as an authoring source.

A state-backed binding uses `{"kind":"state","stateId":"state-ready","field":"submitLabel"}`. `stateId` must match one `states[].id`, and `field` must be a key in that state's `values`; a state source never uses `key` or `path`.

A Prototype `date` input uses a string variable whose value is either empty or a real calendar date in canonical `YYYY-MM-DD` form. Locale-formatted dates, timestamps, timezone suffixes, and impossible dates are invalid.

### Prototype authoring fast path

Read and copy `prototype-runtime-result.example.json` as one complete create-result template before authoring a Prototype. It includes a valid screen/root tree, an explicit form, a variable-backed input, a form-owned submit action, states, and a motion while remaining small enough for one model read. Replace the sample values and expand the arrays; do not delete required fields or break the node/action/binding/motion back-references.

For an exact Prototype-only create Run, finish every requested Screen, state, binding, and interaction before publishing. After all four Prototype stages succeed, call `workbench_artifact_draft_publish` with `artifact_index: 0` and the complete terminal `create` Artifact. Publish only one successful Draft. If an attempted Draft is rejected, correct every reported path and retry the whole Draft; after the first successful Draft, do not call a patch, Draft, or Result tool while automatic validation is pending or after it succeeds. The trusted Runtime submits the normalized Draft and stops. If that automatic Result reports validation issues, do not republish or patch the Draft; repair only the reported paths in a complete candidate and continue through manual `workbench_runtime_result_submit` validation.

For every other Prototype path, submit the complete candidate with `workbench_runtime_result_submit`. If it reports errors, correct all paths and resubmit the whole candidate. Stop after the first `ok:true` response and return only a concise user-facing message. A sub-agent result is draft material, not the final transport artifact.

For a single-screen request, return one screen unless the user explicitly requires more. Prefer at most 48 nodes, 12 actions, 12 bindings, 4 states, and 8 motions, keep the complete response below 16,000 output tokens, and reuse shared tokens, assets, and state instead of duplicating equivalent variants or prose.

Do **not** read the generated `runtime-result.schema.json` while authoring or repairing a Prototype. The generated schema remains authoritative and is used by production validation, but it is not an authorized Prototype authoring reference. Use only the compact example, this contract, and the exact field paths reported by validation.

## Revise An Artifact

An `edit` Run always has non-empty `artifactTargets` and must revise every exact target item once. Copy the complete target object without changing any identifier or `screenIds` order. The operation fragment is:

```json
{
  "operation": {
    "kind": "revise",
    "target": {
      "artifactId": "artifact-prototype",
      "artifactVersionId": "version-7",
      "screenIds": ["screen-home"]
    }
  }
}
```

This fragment is not a complete Runtime result. Reuse the full structure from `prototype-runtime-result.example.json`, but replace its create operation with the exact revise target supplied by the Run. The submitted result must contain the complete next document, retain `documentId`, advance `revision`, satisfy all graph references, and preserve every unselected screen plus shared tokens/assets/variables exactly. For a revision, the target document is authoritative; do not copy the example's sample IDs into it.

The authoritative machine-readable schema is `runtime-result.schema.json` and production validates against it. For Prototype authoring, do not read that schema; use only the compact example, this contract, and exact validation issue paths.

## Hard Rules

- Do not emit `workbench_final_action`; that retired contract belongs to the deleted system.
- Do not emit `workbench_runtime_result`; the trusted submit tool is the only result transport.
- After the first successful terminal Draft in an exact Prototype-only create Run, do not manually call `workbench_runtime_result_submit` unless the trusted automatic Result returns validation issues; after such a rejection, use only the manual complete Result repair path and never republish the Draft.
- Outside that exact create path, do not stop at a Draft; the lead must complete the explicit Result tool path.
- Do not return paths or HTML in place of a typed PRD/Prototype document.
- Do not revise an Artifact during any non-edit workflow, including a generate Run with source targets.
- Do not create a replacement Artifact during an edit workflow.
- Do not omit, invent, reorder, or broaden edit targets.
- Do not use generate targets unless a Prototype is requested; every generate target must have non-empty `screenIds`. Redesign and ideate must not have targets.
- Do not treat a generate target as mutable, guess a target asset `storageKey`, or disguise its binary asset as an attachment.
- Do not include raw candidate JSON in the human-readable `message`.

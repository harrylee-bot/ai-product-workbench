# Runtime Result Contract

The DeerFlow lead agent must submit the complete `workbench.runtime.result.v1` object through the trusted `workbench_runtime_result_submit` tool. 产品工作台 accepts only the current turn's successful ToolMessage artifact and validates it again before persistence. Never emit a `workbench_runtime_result` Markdown fence or raw result JSON in assistant prose.

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

### PRD authoring fast path

Read and copy `prd-runtime-result.example.json` as one complete create-result template before authoring a PRD. It includes every required section, typed inline content, and valid bidirectional goal/requirement/acceptance/flow references. Replace its sample IDs and content, then expand the typed blocks without deleting required fields. Do not derive a JSON shape from the human-readable document outline.

A state-backed binding uses `{"kind":"state","stateId":"state-ready","field":"submitLabel"}`. `stateId` must match one `states[].id`, and `field` must be a key in that state's `values`; a state source never uses `key` or `path`.

A Prototype `date` input uses a string variable whose value is either empty or a real calendar date in canonical `YYYY-MM-DD` form. Locale-formatted dates, timestamps, timezone suffixes, and impossible dates are invalid.

### Prototype authoring fast path

Read and copy `prototype-runtime-result.example.json` as one complete create-result template before authoring a Prototype. It includes a valid screen/root tree, an explicit form, a variable-backed input, a form-owned submit action, states, and a motion while remaining small enough for one model read. Replace the sample values and expand the arrays; do not delete required fields or break the node/action/binding/motion back-references.

Submit the complete candidate with `workbench_runtime_result_submit`. If it reports errors, correct all paths and resubmit the whole candidate. Stop after the first `ok:true` response and return only a concise user-facing message. A sub-agent result is draft material, not the final transport artifact.

For a single-screen request, return one screen unless the user explicitly requires more. Prefer at most 48 nodes, 12 actions, 12 bindings, 4 states, and 8 motions, keep the complete response below 16,000 output tokens, and reuse shared tokens, assets, and state instead of duplicating equivalent variants or prose.

Do **not** read the full generated `runtime-result.schema.json` by default. The generated schema remains authoritative and is used by production validation, but it is not a prompt template. Inspect only the relevant `$defs` when adding a type absent from the compact example (for example an image, icon, select, vector, navigation action, or token), or follow the exact field path reported by validation.

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

The authoritative machine-readable schema is `runtime-result.schema.json`. Validate against it, but for Prototype authoring use the compact example first and read only focused schema definitions when needed.

## Hard Rules

- Do not emit `workbench_final_action`; that retired contract belongs to the deleted system.
- Do not emit `workbench_runtime_result`; the trusted submit tool is the only result transport.
- Do not return paths or HTML in place of a typed PRD/Prototype document.
- Do not revise an Artifact during any non-edit workflow, including a generate Run with source targets.
- Do not create a replacement Artifact during an edit workflow.
- Do not omit, invent, reorder, or broaden edit targets.
- Do not use generate targets unless a Prototype is requested; every generate target must have non-empty `screenIds`. Redesign and ideate must not have targets.
- Do not treat a generate target as mutable, guess a target asset `storageKey`, or disguise its binary asset as an attachment.
- Do not include raw candidate JSON in the human-readable `message`.

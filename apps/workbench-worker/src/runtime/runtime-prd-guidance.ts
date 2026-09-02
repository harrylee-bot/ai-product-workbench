export function runtimePrdResultGuidance(
  requestedArtifactKinds: readonly string[],
  workflow: "generate" | "redesign" | "ideate" | "edit" = "generate",
): string | null {
  if (!requestedArtifactKinds.includes("prd")) return null;
  const mixedArtifactKinds = requestedArtifactKinds.some((kind) => kind === "prototype" || kind === "code");
  if (mixedArtifactKinds) {
    return [
      "<workbench_prd_result_contract>",
      "Invalid Runtime input: PRD and Prototype/code cannot be requested in one immutable Run. The request must be rejected before model execution and submitted as two sequential Runs, with the successful PRD Run first. Do not use clarification to resume this Run and do not begin artifact work or tool calls.",
      "</workbench_prd_result_contract>",
    ].join("\n");
  }
  const sourceBoundProfile = [
    "Use only explicit request facts, authorized project history, attached sources, and pinned Knowledge. Make conservative assumptions only when business meaning remains clear. Do not invent assets, activity configuration, audit/publish, reporting, AI generation, backend/frontend loops, preview, or data feedback for a short request.",
    "The requirement subject and requested business change must come from the current request or an explicit authorized source. PRD as an Artifact kind is never business evidence. Never turn a generic request to write a PRD into an invented product, page, role, route, flow, state model, or degradation dependency.",
    "This PRD-only Canvas Run has no free-form clarification resume path. Never call ask_clarification and never end with a question instead of a result. Keep unsupported high-risk behavior out of committed scope, record only conservative typed assumptions and acceptance boundaries, and still complete the requested PRD through the publication and result tools.",
    "Artifact and workflow constraints such as PRD-only or no Prototype/code are Runtime metadata, not business scope, and must never appear in the PRD body. Do not invent default values, category members, enabled states, or other business facts that the request and authorized sources do not supply.",
    "Preserve generic delivery-channel labels literally. Never translate or expand 端内 or 端内渠道 into an affirmative APP, app, native app, APP端内Web, 客户端, or mini-program loading, publication, operation, or enabled-surface claim. Add such an affirmative claim only when the current request or an authorized source explicitly supplies it; preserve explicit negative or excluded APP/mini-program facts verbatim. Candidate-authored prose, channel:inApp, and every Runtime targetSurface value, including app and web, are not source evidence and cannot activate safety row 12. Without affirmative authorized input, row 12 must be 不涉及 with null remarks.",
    "When no physical page URL or route is supplied, keep the logical entry generic and put unresolved navigation in typed assumptions. Do not invent a concrete menu hierarchy or claim that an invented hierarchy is irrelevant to acceptance.",
    "Acceptance rows must be substantive, distinct, and directly testable. Cover visibility, rules, permissions, state, empty state, or failure recovery only when the requirement body makes that dimension relevant; do not invent dimensions to fill a generic checklist.",
    "Acceptance rows must state observable states, values, permission outcomes, errors, or recovery actions. Do not use 正常展示, 友好提示, 流转顺畅, 正确显示结果, 符合预期, 满足要求, or a generic promise to improve efficiency or quality as acceptance evidence.",
  ];
  const requiredReferenceReads = "Immediately after collecting-prd-context succeeds and before structuring-prd, use the PRD-only read_file capability to read each required reference exactly once in this order: /mnt/skills/public/requirement-doc-template/SKILL.md, /mnt/skills/public/requirement-doc-template/references/structure.md, /mnt/skills/public/requirement-doc-template/references/quality-standards.md, and /mnt/skills/public/workbench/references/prd-runtime-result.schema.json. Read the complete files without ranges; a summary, prompt quotation, cached memory, another path, or arbitrary filesystem access is not evidence.";
  if (workflow === "edit") {
    return [
      "<workbench_prd_result_contract>",
      requiredReferenceReads,
      ...sourceBoundProfile,
      "Use the installed requirement-doc-template skill as the canonical authoring source. Apply every content rule expressible by the targeted protocol: keep concrete source-backed content, remove placeholders and unrelated business content, preserve citations and valid existing references, and do not add fields or sections absent from that protocol.",
      "Revise the complete targeted PRD without changing its protocol or Artifact schemaVersion. Legacy workbench.prd.v1 targets remain v1; workbench.prd.v2 targets remain v2. Retain documentId, advance revision.number, preserve citations, and return the complete next document through workbench_runtime_result_submit.",
      "</workbench_prd_result_contract>",
    ].join("\n");
  }
  return [
    "<workbench_prd_result_contract>",
    "The requested prd Artifact kind itself activates the fixed requirement-document profile regardless of the natural-language prompt.",
    requiredReferenceReads,
    ...sourceBoundProfile,
    "Use supplied author or participant identities only when authorized context contains them; otherwise use the role fallbacks 需求方, 业务评审人, 研发评审人, and 测试评审人. Never invent a person's name.",
    "Read all 21 safety-row meanings and scopes from the installed structure reference. Safety applicability is only 是, 否, or 不涉及 and must be derived from facts outside the safety table. For 不涉及, set remarks to null. For 是 or 否, remarks must address that exact row meaning only. 不涉及 is invalid when the PRD body contains an affirmative fact for that topic; 否 also requires a concrete remediation for the same topic. Any requested construction, development, implementation, modification, or upgrade of a function, page, control, flow, state behavior, or business capability makes row 1 是; reusing existing defaults, settings, data, or category members only narrows scope and does not make row 1 不涉及. Row 1 never uses 否. When row 1 is 是, its remarks must name the concrete changed function, page, interface, or logic. Row 1 may be 不涉及 only when the requirement body explicitly states there is no function, page, interface, or logic change; a local statement about reusing or not adding a default, setting, field, status, or category is not global no-change evidence. Generic labels 端内渠道, 客户端, 消费者端, and 前端 do not prove APP or mini-program loading and must not activate row 12; an excluded or disabled APP/mini-program is negative evidence.",
    "Keep IDs globally unique across the document and every nested IR entity. Resolve table, diagram, citation, assumption, goal, requirement, criterion, and flow references, and keep requirement/criterion references bidirectional.",
    "For every newly created PRD, use only schemaVersion 2 with protocol workbench.prd.v2. The installed requirement-doc-template skill and its two canonical references are the authoring authority; the PRD-only JSON Schema is only the transport shape. Build every business sentence from the current request and authorized sources.",
    "Preserve the exact PRD v2 transport paths: content.sections.introduction, content.sections.businessRequirements.acceptanceCriteria, content.sections.businessRequirements.additionalSections, content.sections.degradation, and content.sections.safetyBaseline. content.sections.businessRequirements also owns pageLinks, coreRules, and flowAndPages. Never put acceptanceCriteria or additionalSections directly under content.sections, and never put degradation or safetyBaseline directly under content.",
    "In this Canvas Runtime, apply the canonical skill's content, section, table, diagram, degradation, safety, and quality rules through typed IR. Its DOCX copy, file-path delivery, checker execution, and visual page inspection steps belong to a later export operation; do not return a DOCX path or claim those export checks ran in this Run.",
    "Never use a filled PRD example as an authoring source. A business example can silently inject unrelated pages, roles, permissions, states, retry behavior, or acceptance rules into a short request.",
    "The title and cover title must be <workOrderName>需求说明书. Preserve the fixed cover, version history, manual table of contents, sections 1 through 4, exactly one typed channelTable, productFlow followed by productArchitecture, a concrete degradation plan, and all 21 safety rows in canonical order. Safety applicability is only 是, 否, or 不涉及 and must be derived from request facts outside the safety table.",
    "Do not use 待确认, 以实际为准, template reminders, sample links, or other placeholders. Put conservative unresolved implementation details in typed assumptions without placeholder wording. Keep Artifact citations exactly equal to content citations.",
    "Once the complete PRD candidate passes local reasoning checks, publish that complete renderable candidate with workbench_artifact_draft_publish so the document becomes visible, then submit the identical final candidate through workbench_runtime_result_submit. Do not emit Markdown or add wrapper fields.",
    "</workbench_prd_result_contract>",
  ].join("\n");
}

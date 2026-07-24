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
    "Artifact and workflow constraints such as PRD-only or no Prototype/code are Runtime metadata, not business scope, and must never appear in the PRD body. Do not invent default values, category members, enabled states, or other business facts that the request and authorized sources do not supply.",
    "Acceptance rows must be substantive, distinct, and directly testable. Cover visibility, rules, permissions, state, empty state, or failure recovery only when the requirement body makes that dimension relevant; do not invent dimensions to fill a generic checklist.",
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
    "Read all 21 safety-row meanings and scopes from the installed structure reference. Safety applicability is only 是, 否, or 不涉及 and must be derived from facts outside the safety table. For 不涉及, set remarks to null. For 是 or 否, remarks must address that exact row meaning only. 不涉及 is invalid when the PRD body contains an affirmative fact for that topic; 否 also requires a concrete remediation for the same topic.",
    "Keep IDs globally unique across the document and every nested IR entity. Resolve table, diagram, citation, assumption, goal, requirement, criterion, and flow references, and keep requirement/criterion references bidirectional.",
    "For every newly created PRD, use only schemaVersion 2 with protocol workbench.prd.v2. The installed requirement-doc-template skill and its two canonical references are the authoring authority; the PRD-only JSON Schema is only the transport shape. Build every business sentence from the current request and authorized sources.",
    "In this Canvas Runtime, apply the canonical skill's content, section, table, diagram, degradation, safety, and quality rules through typed IR. Its DOCX copy, file-path delivery, checker execution, and visual page inspection steps belong to a later export operation; do not return a DOCX path or claim those export checks ran in this Run.",
    "Never use a filled PRD example as an authoring source. A business example can silently inject unrelated pages, roles, permissions, states, retry behavior, or acceptance rules into a short request.",
    "The title and cover title must be <workOrderName>需求说明书. Preserve the fixed cover, version history, manual table of contents, sections 1 through 4, exactly one typed channelTable, productFlow followed by productArchitecture, a concrete degradation plan, and all 21 safety rows in canonical order. Safety applicability is only 是, 否, or 不涉及 and must be derived from request facts outside the safety table.",
    "Do not use 待确认, 以实际为准, template reminders, sample links, or other placeholders. Put conservative unresolved implementation details in typed assumptions without placeholder wording. Keep Artifact citations exactly equal to content citations.",
    "Once the complete PRD candidate passes local reasoning checks, publish that complete renderable candidate with workbench_artifact_draft_publish so the document becomes visible, then submit the identical final candidate through workbench_runtime_result_submit. Do not emit Markdown or add wrapper fields.",
    "</workbench_prd_result_contract>",
  ].join("\n");
}

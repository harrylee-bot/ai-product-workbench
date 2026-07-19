import { z } from "zod";
import { artifactCitationSchema, artifactIrIdSchema } from "./citations.js";
import { isoDateTimeSchema, opaqueIdSchema } from "./common.js";

export const prdSectionKeys = [
  "executiveSummary",
  "problem",
  "goals",
  "targetUsers",
  "scope",
  "requirements",
  "userFlows",
  "acceptanceCriteria",
  "risksAndDependencies",
] as const;

export const prdSectionKeySchema = z.enum(prdSectionKeys);
export const prdReferenceTargetSchema = z.enum([
  "section",
  "goal",
  "requirement",
  "acceptanceCriterion",
  "flow",
  "assumption",
]);

export const prdSafeHrefSchema = z.string()
  .min(1)
  .max(2_048)
  .regex(/^(?:\/|#|[Hh][Tt][Tt][Pp][Ss]?:\/\/|[Mm][Aa][Ii][Ll][Tt][Oo]:)/,
    "href must be an HTTP(S), mailto, root-relative, or fragment URL");

export const prdInlineMarksSchema = z.array(z.enum(["strong", "emphasis", "code", "strikethrough"]))
  .max(4)
  .refine((marks) => new Set(marks).size === marks.length, "inline marks must be unique");

export const prdTextInlineSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(10_000),
  marks: prdInlineMarksSchema,
}).strict();

export const prdLinkInlineSchema = z.object({
  type: z.literal("link"),
  text: z.string().min(1).max(2_000),
  href: prdSafeHrefSchema,
}).strict();

export const prdCitationInlineSchema = z.object({
  type: z.literal("citation"),
  citationId: artifactIrIdSchema,
  label: z.string().min(1).max(240).nullable(),
}).strict();

export const prdReferenceInlineSchema = z.object({
  type: z.literal("reference"),
  targetType: prdReferenceTargetSchema,
  targetId: artifactIrIdSchema,
  label: z.string().min(1).max(240).nullable(),
}).strict();

export const prdInlineSchema = z.discriminatedUnion("type", [
  prdTextInlineSchema,
  prdLinkInlineSchema,
  prdCitationInlineSchema,
  prdReferenceInlineSchema,
]);

export const prdInlineContentSchema = z.array(prdInlineSchema).min(1).max(1_000);

export const prdParagraphBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("paragraph"),
  content: prdInlineContentSchema,
}).strict();

export const prdHeadingBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("heading"),
  level: z.union([z.literal(2), z.literal(3)]),
  content: prdInlineContentSchema,
}).strict();

export const prdListItemSchema = z.object({
  id: artifactIrIdSchema,
  content: prdInlineContentSchema,
}).strict();

export const prdBulletListBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("bulletList"),
  items: z.array(prdListItemSchema).min(1).max(200),
}).strict();

export const prdOrderedListBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("orderedList"),
  items: z.array(prdListItemSchema).min(1).max(200),
}).strict();

export const prdTableColumnSchema = z.object({
  id: artifactIrIdSchema,
  label: z.string().min(1).max(240),
}).strict();

export const prdTableCellSchema = z.object({
  columnId: artifactIrIdSchema,
  content: prdInlineContentSchema,
}).strict();

export const prdTableRowSchema = z.object({
  id: artifactIrIdSchema,
  cells: z.array(prdTableCellSchema).min(1).max(30),
}).strict();

export const prdTableBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("table"),
  columns: z.array(prdTableColumnSchema).min(1).max(30),
  rows: z.array(prdTableRowSchema).min(1).max(500),
}).strict();

export const prdCalloutBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("callout"),
  tone: z.enum(["info", "warning", "success", "critical"]),
  title: z.string().min(1).max(240).nullable(),
  content: prdInlineContentSchema,
}).strict();

export const prdGoalBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("goal"),
  title: z.string().min(1).max(240),
  description: prdInlineContentSchema,
  successMetric: z.string().min(1).max(1_000),
  priority: z.enum(["primary", "secondary"]),
}).strict();

export const prdPersonaBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("persona"),
  name: z.string().min(1).max(160),
  description: prdInlineContentSchema,
  needs: z.array(z.string().min(1).max(500)).min(1).max(30),
  painPoints: z.array(z.string().min(1).max(500)).min(1).max(30),
}).strict();

export const prdRequirementBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("requirement"),
  title: z.string().min(1).max(240),
  description: prdInlineContentSchema,
  priority: z.enum(["must", "should", "could", "wont"]),
  goalIds: z.array(artifactIrIdSchema).min(1).max(50),
  acceptanceCriterionIds: z.array(artifactIrIdSchema).min(1).max(100),
}).strict();

export const prdAcceptanceCriterionBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("acceptanceCriterion"),
  requirementIds: z.array(artifactIrIdSchema).min(1).max(50),
  given: prdInlineContentSchema,
  when: prdInlineContentSchema,
  then: prdInlineContentSchema,
}).strict();

export const prdFlowStepSchema = z.object({
  id: artifactIrIdSchema,
  text: z.string().min(1).max(2_000),
  requirementIds: z.array(artifactIrIdSchema).min(1).max(50),
}).strict();

export const prdFlowBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("flow"),
  title: z.string().min(1).max(240),
  actor: z.string().min(1).max(240),
  trigger: z.string().min(1).max(1_000),
  steps: z.array(prdFlowStepSchema).min(1).max(100),
  outcome: z.string().min(1).max(2_000),
}).strict();

export const prdRiskBlockSchema = z.object({
  id: artifactIrIdSchema,
  type: z.literal("risk"),
  description: prdInlineContentSchema,
  likelihood: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  mitigation: prdInlineContentSchema,
}).strict();

export const prdBlockSchema = z.discriminatedUnion("type", [
  prdParagraphBlockSchema,
  prdHeadingBlockSchema,
  prdBulletListBlockSchema,
  prdOrderedListBlockSchema,
  prdTableBlockSchema,
  prdCalloutBlockSchema,
  prdGoalBlockSchema,
  prdPersonaBlockSchema,
  prdRequirementBlockSchema,
  prdAcceptanceCriterionBlockSchema,
  prdFlowBlockSchema,
  prdRiskBlockSchema,
]);

export const prdSectionSchema = z.object({
  title: z.string().min(1).max(240),
  blocks: z.array(prdBlockSchema).min(1).max(500),
}).strict();

export const prdSectionsSchema = z.object({
  executiveSummary: prdSectionSchema,
  problem: prdSectionSchema,
  goals: prdSectionSchema,
  targetUsers: prdSectionSchema,
  scope: prdSectionSchema,
  requirements: prdSectionSchema,
  userFlows: prdSectionSchema,
  acceptanceCriteria: prdSectionSchema,
  risksAndDependencies: prdSectionSchema,
}).strict();

export const prdRevisionSchema = z.object({
  number: z.number().int().positive(),
  status: z.enum(["draft", "inReview", "approved"]),
  summary: z.string().min(1).max(2_000),
  changedAt: isoDateTimeSchema,
  changedById: opaqueIdSchema.nullable(),
}).strict();

export const prdAssumptionSchema = z.object({
  id: artifactIrIdSchema,
  statement: z.string().min(1).max(2_000),
  status: z.enum(["open", "validated", "rejected"]),
  impact: z.enum(["low", "medium", "high"]),
  owner: z.string().min(1).max(240).nullable(),
  introducedInRevision: z.number().int().positive(),
  citationIds: z.array(artifactIrIdSchema).max(100),
}).strict();

const sectionAllowedBlockTypes: Record<typeof prdSectionKeys[number], ReadonlySet<z.infer<typeof prdBlockSchema>["type"]>> = {
  executiveSummary: new Set(["paragraph", "heading", "callout", "table"]),
  problem: new Set(["paragraph", "heading", "callout", "table"]),
  goals: new Set(["paragraph", "heading", "goal", "table"]),
  targetUsers: new Set(["paragraph", "heading", "persona", "table"]),
  scope: new Set(["paragraph", "heading", "bulletList", "orderedList", "callout", "table"]),
  requirements: new Set(["paragraph", "heading", "requirement", "callout", "table"]),
  userFlows: new Set(["paragraph", "heading", "flow", "callout"]),
  acceptanceCriteria: new Set(["paragraph", "heading", "acceptanceCriterion", "callout", "table"]),
  risksAndDependencies: new Set(["paragraph", "heading", "risk", "callout", "table"]),
};

const semanticSectionGate: Partial<Record<typeof prdSectionKeys[number], z.infer<typeof prdBlockSchema>["type"]>> = {
  goals: "goal",
  targetUsers: "persona",
  requirements: "requirement",
  userFlows: "flow",
  acceptanceCriteria: "acceptanceCriterion",
  risksAndDependencies: "risk",
};

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function blockInlines(block: z.infer<typeof prdBlockSchema>) {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "callout":
      return [block.content];
    case "bulletList":
    case "orderedList":
      return block.items.map((item) => item.content);
    case "table":
      return block.rows.flatMap((row) => row.cells.map((cell) => cell.content));
    case "goal":
    case "persona":
    case "requirement":
      return [block.description];
    case "acceptanceCriterion":
      return [block.given, block.when, block.then];
    case "risk":
      return [block.description, block.mitigation];
    case "flow":
      return [];
  }
}

export const prdDocumentSchema = z.object({
  protocol: z.literal("workbench.prd.v1"),
  documentId: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  revision: prdRevisionSchema,
  assumptions: z.array(prdAssumptionSchema).max(500),
  citations: z.array(artifactCitationSchema).max(1_000),
  sections: prdSectionsSchema,
}).strict().superRefine((document, context) => {
  const allBlocks = prdSectionKeys.flatMap((key) => document.sections[key].blocks);
  const goals = allBlocks.filter((block): block is z.infer<typeof prdGoalBlockSchema> => block.type === "goal");
  const requirements = allBlocks.filter((block): block is z.infer<typeof prdRequirementBlockSchema> => block.type === "requirement");
  const criteria = allBlocks.filter((block): block is z.infer<typeof prdAcceptanceCriterionBlockSchema> => block.type === "acceptanceCriterion");
  const flows = allBlocks.filter((block): block is z.infer<typeof prdFlowBlockSchema> => block.type === "flow");
  const goalIds = new Set(goals.map((goal) => goal.id));
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const flowIds = new Set(flows.map((flow) => flow.id));
  const assumptionIds = new Set(document.assumptions.map((assumption) => assumption.id));
  const citationIds = new Set(document.citations.map((citation) => citation.id));

  const allIds = [document.documentId];
  for (const block of allBlocks) {
    allIds.push(block.id);
    if (block.type === "bulletList" || block.type === "orderedList") {
      allIds.push(...block.items.map((item) => item.id));
    } else if (block.type === "table") {
      allIds.push(...block.columns.map((column) => column.id), ...block.rows.map((row) => row.id));
    } else if (block.type === "flow") {
      allIds.push(...block.steps.map((step) => step.id));
    }
  }
  allIds.push(...document.assumptions.map((assumption) => assumption.id));
  allIds.push(...document.citations.map((citation) => citation.id));
  for (const duplicate of duplicateValues(allIds)) {
    addIssue(context, [], `IR id must be globally unique: ${duplicate}`);
  }

  for (const key of prdSectionKeys) {
    const section = document.sections[key];
    for (const [index, block] of section.blocks.entries()) {
      if (!sectionAllowedBlockTypes[key].has(block.type)) {
        addIssue(context, ["sections", key, "blocks", index, "type"], `${block.type} is not allowed in ${key}`);
      }
    }
    const requiredType = semanticSectionGate[key];
    if (requiredType && !section.blocks.some((block) => block.type === requiredType)) {
      addIssue(context, ["sections", key, "blocks"], `${key} must contain at least one ${requiredType} block`);
    }
  }

  const scopeBlocks = document.sections.scope.blocks;
  if (!scopeBlocks.some((block) => block.type === "bulletList" || block.type === "orderedList")) {
    addIssue(context, ["sections", "scope", "blocks"], "scope must contain at least one explicit list");
  }

  for (const [index, requirement] of requirements.entries()) {
    for (const duplicate of duplicateValues([...requirement.goalIds, ...requirement.acceptanceCriterionIds])) {
      addIssue(context, ["sections", "requirements", "blocks", index], `duplicate requirement reference: ${duplicate}`);
    }
    for (const goalId of requirement.goalIds) {
      if (!goalIds.has(goalId)) addIssue(context, ["sections", "requirements", "blocks", index, "goalIds"], `unknown goal: ${goalId}`);
    }
    for (const criterionId of requirement.acceptanceCriterionIds) {
      const criterion = criteria.find((candidate) => candidate.id === criterionId);
      if (!criterion) {
        addIssue(context, ["sections", "requirements", "blocks", index, "acceptanceCriterionIds"], `unknown acceptance criterion: ${criterionId}`);
      } else if (!criterion.requirementIds.includes(requirement.id)) {
        addIssue(context, ["sections", "requirements", "blocks", index, "acceptanceCriterionIds"], `acceptance criterion ${criterionId} must reference requirement ${requirement.id}`);
      }
    }
  }

  for (const [index, criterion] of criteria.entries()) {
    for (const requirementId of criterion.requirementIds) {
      const requirement = requirements.find((candidate) => candidate.id === requirementId);
      if (!requirement) {
        addIssue(context, ["sections", "acceptanceCriteria", "blocks", index, "requirementIds"], `unknown requirement: ${requirementId}`);
      } else if (!requirement.acceptanceCriterionIds.includes(criterion.id)) {
        addIssue(context, ["sections", "acceptanceCriteria", "blocks", index, "requirementIds"], `requirement ${requirementId} must reference acceptance criterion ${criterion.id}`);
      }
    }
  }

  for (const [flowIndex, flow] of flows.entries()) {
    for (const [stepIndex, step] of flow.steps.entries()) {
      for (const requirementId of step.requirementIds) {
        if (!requirementIds.has(requirementId)) {
          addIssue(context, ["sections", "userFlows", "blocks", flowIndex, "steps", stepIndex, "requirementIds"], `unknown requirement: ${requirementId}`);
        }
      }
    }
  }

  for (const [index, assumption] of document.assumptions.entries()) {
    if (assumption.introducedInRevision > document.revision.number) {
      addIssue(context, ["assumptions", index, "introducedInRevision"], "assumption cannot be introduced after the current revision");
    }
    for (const citationId of assumption.citationIds) {
      if (!citationIds.has(citationId)) addIssue(context, ["assumptions", index, "citationIds"], `unknown citation: ${citationId}`);
    }
  }

  const referenceSets = {
    section: new Set<string>(prdSectionKeys),
    goal: goalIds,
    requirement: requirementIds,
    acceptanceCriterion: criterionIds,
    flow: flowIds,
    assumption: assumptionIds,
  };
  for (const [blockIndex, block] of allBlocks.entries()) {
    if (block.type === "table") {
      const columnIds = block.columns.map((column) => column.id);
      for (const duplicate of duplicateValues(columnIds)) addIssue(context, ["sections", "table", blockIndex, "columns"], `duplicate table column: ${duplicate}`);
      for (const [rowIndex, row] of block.rows.entries()) {
        const cellIds = row.cells.map((cell) => cell.columnId);
        if (duplicateValues(cellIds).length > 0 || cellIds.length !== columnIds.length || cellIds.some((id) => !columnIds.includes(id))) {
          addIssue(context, ["sections", "table", blockIndex, "rows", rowIndex, "cells"], "each table row must contain exactly one cell for every column");
        }
      }
    }
    for (const content of blockInlines(block)) {
      for (const inline of content) {
        if (inline.type === "citation" && !citationIds.has(inline.citationId)) {
          addIssue(context, ["sections"], `unknown citation: ${inline.citationId}`);
        } else if (inline.type === "reference" && !referenceSets[inline.targetType].has(inline.targetId)) {
          addIssue(context, ["sections"], `unknown ${inline.targetType} reference: ${inline.targetId}`);
        }
      }
    }
  }
});

export type PrdDocument = z.infer<typeof prdDocumentSchema>;
export type PrdBlock = z.infer<typeof prdBlockSchema>;
export type PrdInline = z.infer<typeof prdInlineSchema>;
export type PrdSectionKey = z.infer<typeof prdSectionKeySchema>;

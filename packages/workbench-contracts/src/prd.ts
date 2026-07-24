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

export const prdDocumentV1Schema = z.object({
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

export const prdTableOfContentsEntries = [
  "1 引言",
  "1.1项目背景",
  "1.2文档范围",
  "1.3使用场景（必填）",
  "2 业务需求",
  "2.1页面链接",
  "2.2 核心业务规则/功能说明",
  "2.3 核心流程/状态/页面要求",
  "2.4 验收标准",
  "3. 业务降级方案（必填）",
  "4. 需求安全基线要求（必填）",
] as const;

const prdAdditionalSectionTocIndex = 9;
export const prdAdditionalBusinessSectionLimit = 50;

export function prdTableOfContentsEntriesFor(
  additionalSectionTitles: readonly string[] = [],
): string[] {
  return [
    ...prdTableOfContentsEntries.slice(0, prdAdditionalSectionTocIndex),
    ...additionalSectionTitles,
    ...prdTableOfContentsEntries.slice(prdAdditionalSectionTocIndex),
  ];
}

export const prdChannelKinds = ["inApp", "wapH5", "miniProgram"] as const;

export const prdChannelLabels: Record<typeof prdChannelKinds[number], string> = {
  inApp: "端内渠道",
  wapH5: "WAP/H5端外渠道",
  miniProgram: "小程序",
};

export const prdSafetyBaselineIntro = [
  "该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：",
  "1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据",
  "2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；",
  "3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。",
  "建议：该表格请业务人员和开发人员共同参与自查并填写。",
].join("\n");

export const prdSafetyBaselineItems = [
  { sequence: 1, requirement: "是否有新开发功能接口或现有功能接口逻辑变动", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 2, requirement: "业务功能是否面向公众用户", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 3, requirement: "是否涉及新开通公网暴露面", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 4, requirement: "管理后台涉及个人信息的内容要求脱敏展示，原则上不做非脱敏个人信息的导出功能。", scope: "管理后台" },
  { sequence: 5, requirement: "管理后台所有操作页面要有水印功能，水印至少包括姓名、手机号、操作时间等信息", scope: "管理后台" },
  { sequence: 6, requirement: "管理后台涉及查询的页面，不允许没有查询条件查询所有数据，必须输入查询条件后才可以查询数据；", scope: "管理后台" },
  { sequence: 7, requirement: "管理后台应接入4A统一管理，实现一点注销的功能，不允许有独立的账号体系；按4A要求实现日志留存，并实现风险预警功能；", scope: "管理后台" },
  { sequence: 8, requirement: "如未接入4A系统统一管理，应满足通行字的18项安全要求；要求细则找安全中心要；", scope: "管理后台" },
  { sequence: 9, requirement: "涉及后台配置内容的需要实现“敏感词过滤”能力；", scope: "管理后台" },
  { sequence: 10, requirement: "所有在前台展示的内容如为后台配置显示，均需要执行“先审后发”，1、具备“先审后发”能力，2、同步发布数据；3、内部发布上线和下线都需要经过“先审后发”。", scope: "前台展示" },
  { sequence: 11, requirement: "是否涉及展示《隐私政策》：新业务场景《隐私政策》或已有《隐私政策》的变更需要进行法务及安全审核；《隐私政策》应为独立的文档，四次点击应能访问到独立的菜单；用户未同意《隐私政策》前，不得获取用户任何信息；", scope: "前端页面" },
  { sequence: 12, requirement: "如涉及加载到APP或小程序，APP、小程序业务应实现双清单功能，“用户信息收集清单”应动态准实时展现采集的个人信息具体内容；“第三方信息共享清单”应涵盖业务所有涉及到的第三方公司及内容；", scope: "前端展示 底层接口获取数据" },
  { sequence: 13, requirement: "前台页面涉及采集身份证号码、身份证照片、生物识别和银行卡信息时，应再次获取用户的主动授权同意。", scope: "前端页面" },
  { sequence: 14, requirement: "是否涉及免密登录。免密登录的不能为无感知免密登录，需经过用户同意《数字生活隐私政策》后才可以进行免密登录。", scope: "前端页面" },
  { sequence: 15, requirement: "是否涉及跳转第三方页面或应用。如涉及，应进行弹窗提示，文案应包含：即将跳转的业务名称、第三方公司名称、传的用户信息用户操作目的及第三方的《隐私政策》相关内容，可参考线上已有弹窗。", scope: "前端页面" },
  { sequence: 16, requirement: "如涉及与第三方公司接口对接进行数据交互，应先查看对应的《数据使用审批单》无误后，才可以正式上线；", scope: "前台、后台" },
  { sequence: 17, requirement: "API接口安全管理：如为新增API接口，需完成台账填报；", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 18, requirement: "涉及用户敏感信息或跨系统的API是否采用加密传输，具备接口鉴权、访问控制等措施；", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 19, requirement: "是否涉及用户信息或重要数据存储，是否进行加密存储；", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 20, requirement: "是否涉及数据采集，是否建立数据采集规范，明确数采集方式、渠道、数据格式、采集流程等；", scope: "信息系统（包含前端、后端、管理后台）" },
  { sequence: 21, requirement: "是否对采集到的数据进行完整性和一致性校验；", scope: "信息系统（包含前端、后端、管理后台）" },
] as const;

export const prdVersionHistoryEntrySchema = z.object({
  status: z.enum(["讨论稿", "评审中", "已定稿"]),
  author: z.string().min(1).max(120),
  participants: z.array(z.string().min(1).max(120)).min(1).max(30),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  notes: z.string().min(1).max(1_000),
}).strict();

export const prdChannelRowSchema = z.object({
  sequence: z.number().int().min(1).max(3),
  channel: z.enum(prdChannelKinds),
  enabled: z.boolean(),
}).strict();

export const prdDiagramNodeSchema = z.object({
  id: artifactIrIdSchema,
  label: z.string().min(1).max(240),
  group: z.string().min(1).max(120).nullable(),
}).strict();

export const prdDiagramEdgeSchema = z.object({
  id: artifactIrIdSchema,
  from: artifactIrIdSchema,
  to: artifactIrIdSchema,
  label: z.string().min(1).max(240).nullable(),
}).strict();

export const prdDiagramSchema = z.object({
  id: artifactIrIdSchema,
  kind: z.enum(["productFlow", "productArchitecture"]),
  title: z.enum(["图1 产品流程图", "图2 产品架构图"]),
  description: z.string().min(20).max(2_000),
  nodes: z.array(prdDiagramNodeSchema).min(4).max(40),
  edges: z.array(prdDiagramEdgeSchema).min(3).max(80),
}).strict();

export const prdSafetyBaselineRowSchema = z.object({
  sequence: z.number().int().min(1).max(21),
  applicability: z.enum(["是", "否", "不涉及"]),
  remarks: z.string().min(1).max(1_000).nullable(),
}).strict();

const prdV2SectionSchema = z.object({
  title: z.string().min(1).max(240),
  blocks: z.array(prdBlockSchema).min(1).max(500),
}).strict();

export const prdAdditionalBusinessSectionSchema = prdV2SectionSchema.extend({
  title: z.string()
    .min(5)
    .max(240)
    .regex(/^2\.(?:[5-9]|[1-9]\d+)\s+\S/u, "additional business section title must use 2.5+ numbering"),
}).strict();

const prdV2ForbiddenPlaceholders = [
  "待确认",
  "以实际为准",
  "以实际上线地址为准",
  "更新此内容",
  "删除此内容",
  "业务大大名字",
  "最后记得",
  "仅提醒",
  "需要各位业务大大",
  "XXX/XXXXX",
  "xxxx年xx月xx日",
  "例子：",
  "提醒：",
] as const;

const prdV2ForbiddenPlaceholderPatterns = [
  /\b(?:TBD|TBC|TODO|FIXME|PLACEHOLDER)\b/iu,
  /(?:待补充|待完善|待填写|待提供|后续补充|后续确认|暂定|待定)/u,
  /<[^<>\n]{1,80}>/u,
  /https?:\/\/(?:www\.)?example\.(?:com|org|net|test)(?:[\/:?#]|$)/iu,
] as const;

const prdV2WeakStandalonePatterns = [
  /^(?:(?:本|该)(?:页面|功能|模块))?与.+逻辑相同[。.]*$/u,
  /^(?:(?:本|该)(?:需求|页面|功能|模块))?在.+基础上[。.]*$/u,
  /^(?:沿用|复用).{1,80}(?:逻辑|规则)[。.]*$/u,
] as const;

const prdV2StandaloneApiHeadingPattern = /(?:接口|API)/iu;

type PrdV2EvidenceRule = {
  positive: RegExp;
  negative?: RegExp;
};

const prdV2SafetyEvidenceRules: Record<number, PrdV2EvidenceRule> = {
  1: {
    positive: /(?:新增|新开发|修改|调整|变更|改造).{0,20}(?:功能|接口|逻辑|页面|能力)|(?:功能|接口|逻辑|页面|能力).{0,20}(?:新增|修改|调整|变更|改造)/u,
    negative: /(?:不涉及|无需).{0,20}(?:功能|接口|逻辑|页面|能力).{0,12}(?:新增|修改|调整|变更|改造)|(?:不涉及|无需|未|不)(?:新增|修改|调整|变更|改造)/u,
  },
  2: {
    positive: /(?:面向|开放给|提供给)\s*(?:(?:所有|全部|全体|已登录|未登录)\s*的?\s*)?(?:公众用户|公众|外部用户|游客|未登录用户|消费者|个人用户|C端用户)|支持\s*(?:已登录\s*的?\s*)?(?:公众用户|公众|外部用户|游客|未登录用户|消费者|个人用户|C端用户)(?:可|可以|能够|能|通过|从|在|访问|使用|查看|进入|配置)|(?:目标用户|适用用户|服务对象)\s*(?:是|为|包括|包含|[:：])\s*(?:(?:所有|全部|全体|已登录|未登录)\s*的?\s*)?(?:公众用户|公众|外部用户|游客|未登录用户|消费者|个人用户|C端用户)|(?:公众用户|游客|未登录用户|消费者|个人用户|C端用户)(?!可(?:以)?[由被]|能(?:够)?[由被])(?:(?:可|可以|能够|能|通过|从|在).{0,16}(?:访问|使用|查看|进入|配置)|(?:访问|使用|查看|进入|配置))/iu,
    negative: /(?:不面向|非公众|不对公众|仅限?(?:内部|员工|登录业务用户))|(?:不再|尚未)\s*(?:面向|开放给|提供给).{0,16}(?:公众用户|公众|外部用户|游客|未登录用户|消费者|个人用户|C端用户)|(?:不再|尚不|暂不|没有|不|未)支持.{0,16}(?:公众用户|公众|外部用户|游客|未登录用户|消费者|个人用户|C端用户)/u,
  },
  3: {
    positive: /(?:新增|开通|开放|暴露).{0,12}(?:公网|互联网|外网)(?:入口|域名|地址|服务|页面|接口|暴露面)?/u,
    negative: /(?:不涉及|不新增|未新增|不开通|未开通|不开放|未开放|不暴露|未暴露).{0,12}(?:公网|互联网|外网)|(?:公网|互联网|外网).{0,12}(?:不涉及|不新增|未新增|不开通|未开通|不开放|未开放|不暴露|未暴露)/u,
  },
  4: {
    positive: /(?:管理后台|运营后台|后台).{0,24}(?:个人信息|手机号|身份证|敏感信息).{0,24}(?:脱敏|导出)|(?:个人信息|手机号|身份证|敏感信息).{0,24}(?:后台).{0,24}(?:脱敏|导出)/u,
    negative: /不涉及.{0,12}(?:个人信息|敏感信息)|(?:不采集|不展示|不导出).{0,12}(?:个人信息|敏感信息)/u,
  },
  5: {
    positive: /(?:管理后台|运营后台|后台).{0,20}(?:水印|操作水印)|水印.{0,16}(?:姓名|手机号|操作时间)/u,
    negative: /(?:不涉及|无需|不启用|未启用).{0,12}水印/u,
  },
  6: {
    positive: /(?:管理后台|运营后台|后台).{0,28}(?:查询条件|条件查询|筛选).{0,20}(?:查询|数据)|(?:查询条件|条件查询).{0,20}(?:管理后台|运营后台|后台)/u,
    negative: /不涉及.{0,12}(?:后台查询|查询页面)/u,
  },
  7: {
    positive: /(?:管理后台|运营后台|后台).{0,20}(?:4A|统一账号|统一身份|一点注销|日志留存|风险预警)|(?:4A|统一账号|统一身份).{0,20}(?:接入|管理|注销|日志|预警)/iu,
    negative: /(?:未|不|尚未)接入.{0,4}4A/iu,
  },
  8: {
    positive: /(?:未|不|尚未)接入.{0,4}4A|(?:独立账号|独立账户|本地账号).{0,16}(?:体系|登录)/iu,
  },
  9: {
    positive: /(?:后台配置|运营配置|管理后台).{0,24}(?:敏感词|内容过滤)|(?:敏感词|内容过滤).{0,24}(?:后台配置|运营配置|管理后台)/u,
    negative: /不涉及.{0,12}(?:后台配置|敏感词)|无需.{0,8}(?:敏感词|内容过滤)/u,
  },
  10: {
    positive: /(?:后台配置|运营配置|管理后台).{0,28}(?:前台|前端|用户端).{0,20}(?:展示|发布)|(?:先审后发|审核后发布|内容审核)/u,
    negative: /不涉及.{0,16}(?:后台配置|前台展示)|无需.{0,8}(?:审核|先审后发)/u,
  },
  11: {
    positive: /(?:隐私政策|隐私协议).{0,24}(?:展示|变更|同意|授权|审核)|(?:展示|变更|同意|授权|审核).{0,24}(?:隐私政策|隐私协议)/u,
    negative: /不涉及.{0,12}(?:隐私政策|隐私协议)|无需.{0,8}(?:隐私政策|隐私协议)/u,
  },
  12: {
    positive: /(?:APP|小程序).{0,24}(?:加载|业务|入口|页面|双清单|信息收集)|(?:加载|发布|投放|运行).{0,16}(?:APP|小程序)/iu,
    negative: /(?:不涉及|不启用|未启用|不投放|未投放|排除).{0,12}(?:APP|小程序)|(?:APP|小程序).{0,12}(?:不涉及|不启用|未启用|不投放|未投放|排除)/iu,
  },
  13: {
    positive: /(?:采集|收集|提交|上传).{0,16}(?:身份证|银行卡|生物识别)|(?:身份证|银行卡|生物识别).{0,16}(?:采集|收集|提交|上传|授权)/u,
    negative: /(?:不采集|未采集|不收集|未收集|无需提交|不涉及).{0,12}(?:身份证|银行卡|生物识别)|(?:身份证|银行卡|生物识别).{0,12}(?:不采集|不收集|不涉及)/u,
  },
  14: {
    positive: /(?:免密登录|一键登录|无密码登录).{0,20}(?:启用|使用|登录|授权|同意)?/u,
    negative: /(?:不涉及|不启用|未启用|不使用|未使用).{0,12}(?:免密登录|一键登录|无密码登录)|(?:免密登录|一键登录|无密码登录).{0,12}(?:不涉及|不启用|未启用)/u,
  },
  15: {
    positive: /(?:跳转|打开).{0,16}(?:第三方|外部).{0,12}(?:页面|应用|网站|系统)|(?:第三方|外部).{0,12}(?:页面|应用|网站).{0,16}(?:跳转|打开)/u,
    negative: /(?:不跳转|未跳转|不涉及|无需跳转|排除).{0,12}(?:第三方|外部)|(?:第三方|外部).{0,12}(?:不跳转|未跳转|不涉及)/u,
  },
  16: {
    positive: /(?:第三方|外部公司).{0,20}(?:接口对接|数据交互|数据交换|数据共享)|(?:接口对接|数据交互|数据交换|数据共享).{0,20}(?:第三方|外部公司)/u,
    negative: /(?:不对接|未对接|不涉及|无|不与).{0,12}(?:第三方|外部公司)|(?:第三方|外部公司).{0,16}(?:不对接|未对接|不涉及|不进行.{0,4}对接)/u,
  },
  17: {
    positive: /(?:新增|新建|新开发).{0,12}(?:API|接口)|(?:API|接口).{0,12}(?:新增|新建|新开发|台账)/iu,
    negative: /(?:不新增|未新增|无新增|不涉及).{0,12}(?:API|接口)|(?:API|接口).{0,12}(?:不新增|未新增|无新增|不涉及)/iu,
  },
  18: {
    positive: /(?:敏感信息|跨系统).{0,20}(?:API|接口|调用|传输)|(?:API|接口|调用|传输).{0,20}(?:敏感信息|跨系统)|(?:API|接口|敏感信息|跨系统).{0,24}(?:鉴权|访问控制|加密传输)|(?:鉴权|访问控制|加密传输).{0,24}(?:API|接口|敏感信息|跨系统)/iu,
    negative: /(?:不涉及|不包含|无).{0,12}(?:敏感信息|跨系统)|(?:不跨系统|无跨系统调用)/u,
  },
  19: {
    positive: /(?:用户信息|重要数据).{0,16}(?:存储|落库|保存)|(?:存储|落库|保存).{0,16}(?:用户信息|重要数据)/u,
    negative: /(?:不存储|未存储|不落库|未落库|不保存|不涉及).{0,12}(?:用户信息|重要数据)|(?:用户信息|重要数据).{0,12}(?:不存储|不落库|不保存|不涉及)/u,
  },
  20: {
    positive: /(?:采集|收集).{0,16}(?:数据|信息)|(?:数据采集|信息采集).{0,20}(?:方式|渠道|格式|流程|规范)/u,
    negative: /(?:不采集|未采集|不收集|未收集|不涉及).{0,12}(?:数据|信息)|(?:数据|信息).{0,12}(?:不采集|不收集|不涉及)/u,
  },
  21: {
    positive: /(?:数据|信息|字段|状态|提交内容).{0,24}(?:完整性|一致性).{0,12}(?:校验|检查|验证)|(?:完整性|一致性).{0,20}(?:校验|检查|验证)|(?:校验|检查|验证).{0,20}(?:完整性|一致性)/u,
    negative: /(?:不校验|未校验|无需校验|不涉及).{0,12}(?:完整性|一致性)|(?:完整性|一致性).{0,12}(?:不校验|未校验|无需校验|不涉及)/u,
  },
};

const prdV2SafetyRemediationPattern = /(?:整改|改造|补齐|补充|完善|修复|接入|上线前需|上线前必须|发布前需|发布前必须|需(?:完成|增加|补充|接入|改造)|应(?:完成|增加|补充|接入|改造))/u;

const prdV2AcceptanceDimensions = [
  {
    key: "visibility",
    label: "页面或入口可见性",
    pattern: /(?:可见|展示|显示|入口|页面|标签|Tab)/iu,
    relevancePattern: /(?:可见|展示|显示|入口|页面|标签|Tab)/iu,
  },
  {
    key: "rules",
    label: "输入或业务规则",
    pattern: /(?:规则|校验|必填|输入|数据|重复|排序|筛选)/u,
    relevancePattern: /(?:业务规则|校验|必填|输入|重复|排序|筛选)/u,
  },
  {
    key: "permission",
    label: "权限控制",
    pattern: /(?:权限|授权|角色|无权)/u,
    relevancePattern: /(?:权限|授权|无权)|(?:角色.{0,16}(?:不可|只能|允许|禁止|访问|操作|可)|(?:不可|只能|允许|禁止|访问|操作|可).{0,16}角色)/u,
  },
  {
    key: "state",
    label: "状态流转与结果",
    pattern: /(?:状态|流转|提交|审核|结果|成功|完成)/u,
    relevancePattern: /(?:状态|流转|提交|审核|发布|撤回|生效|下线)/u,
  },
  {
    key: "empty",
    label: "空状态",
    pattern: /(?:空态|空状态|暂无|无数据|尚未提交)/u,
    relevancePattern: /(?:空态|空状态|暂无|无数据|尚未提交)/u,
  },
  {
    key: "failureRecovery",
    label: "失败或异常恢复",
    pattern: /(?:失败|异常|错误|重试|恢复|降级)/u,
    relevancePattern: /(?:失败|异常|错误|重试|恢复|降级)/u,
  },
] as const;

const prdChannelEvidenceRules: Record<typeof prdChannelKinds[number], PrdV2EvidenceRule> = {
  inApp: {
    positive: /(?:端内渠道|端内入口|APP\s*端内|客户端内|应用内)/iu,
    negative: /(?:不涉及|不启用|未启用|不投放|未投放|排除).{0,8}(?:端内|应用内)|(?:端内|应用内).{0,8}(?:不涉及|不启用|未启用|不投放|未投放|排除)/u,
  },
  wapH5: {
    positive: /(?:WAP|H5|端外渠道|Web\s*页面|网页端)/iu,
    negative: /(?:不涉及|不启用|未启用|不投放|未投放|排除).{0,8}(?:WAP|H5|端外|网页端)|(?:WAP|H5|端外|网页端).{0,8}(?:不涉及|不启用|未启用|不投放|未投放|排除)/iu,
  },
  miniProgram: {
    positive: /小程序/u,
    negative: /(?:不涉及|不启用|未启用|不投放|未投放|排除).{0,8}小程序|小程序.{0,8}(?:不涉及|不启用|未启用|不投放|未投放|排除)/u,
  },
};

export const prdDocumentV2Schema = z.object({
  protocol: z.literal("workbench.prd.v2"),
  documentId: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  revision: prdRevisionSchema,
  cover: z.object({
    workOrderName: z.string().min(1).max(200),
    title: z.string().min(1).max(240),
  }).strict(),
  versionHistory: z.array(prdVersionHistoryEntrySchema).min(1).max(100),
  tableOfContents: z.object({
    title: z.literal("目 录"),
    entries: z.array(z.string().min(1).max(240))
      .min(prdTableOfContentsEntries.length)
      .max(prdTableOfContentsEntries.length + prdAdditionalBusinessSectionLimit),
  }).strict(),
  assumptions: z.array(prdAssumptionSchema).max(500),
  citations: z.array(artifactCitationSchema).max(1_000),
  sections: z.object({
    introduction: z.object({
      title: z.literal("1 引言"),
      background: prdV2SectionSchema.extend({ title: z.literal("1.1项目背景") }).strict(),
      scope: prdV2SectionSchema.extend({ title: z.literal("1.2文档范围") }).strict(),
      usageScenarios: prdV2SectionSchema.extend({
        title: z.literal("1.3使用场景（必填）"),
        channelTable: z.object({
          title: z.literal("活动投放渠道"),
          rows: z.array(prdChannelRowSchema)
            .min(prdChannelKinds.length)
            .max(prdChannelKinds.length),
        }).strict(),
      }).strict(),
    }).strict(),
    businessRequirements: z.object({
      title: z.literal("2 业务需求"),
      summary: prdInlineContentSchema,
      pageLinks: prdV2SectionSchema.extend({ title: z.literal("2.1页面链接") }).strict(),
      coreRules: prdV2SectionSchema.extend({ title: z.literal("2.2 核心业务规则/功能说明") }).strict(),
      flowAndPages: prdV2SectionSchema.extend({
        title: z.literal("2.3 核心流程/状态/页面要求"),
        diagrams: z.array(prdDiagramSchema).min(2).max(2),
      }).strict(),
      acceptanceCriteria: prdV2SectionSchema.extend({ title: z.literal("2.4 验收标准") }).strict(),
      additionalSections: z.array(prdAdditionalBusinessSectionSchema)
        .max(prdAdditionalBusinessSectionLimit)
        .default([]),
    }).strict(),
    degradation: z.object({
      title: z.literal("3 业务降级方案（必填）"),
      applicable: z.boolean(),
      content: prdInlineContentSchema,
    }).strict(),
    safetyBaseline: z.object({
      title: z.literal("4 需求安全基线要求（必填）"),
      intro: z.literal(prdSafetyBaselineIntro),
      rows: z.array(prdSafetyBaselineRowSchema)
        .min(prdSafetyBaselineItems.length)
        .max(prdSafetyBaselineItems.length),
    }).strict(),
  }).strict(),
}).strict().superRefine((document, context) => {
  const expectedTitle = `${document.cover.workOrderName}需求说明书`;
  if (document.title !== expectedTitle || document.cover.title !== expectedTitle) {
    addIssue(context, ["cover", "title"], "document title and cover title must equal <workOrderName>需求说明书");
  }

  for (const [index, section] of document.sections.businessRequirements.additionalSections.entries()) {
    const expectedPrefix = `2.${index + 5} `;
    if (!section.title.startsWith(expectedPrefix)) {
      addIssue(
        context,
        ["sections", "businessRequirements", "additionalSections", index, "title"],
        `additional business section title must start with ${expectedPrefix}`,
      );
    }
  }

  const expectedTableOfContentsEntries = prdTableOfContentsEntriesFor(
    document.sections.businessRequirements.additionalSections.map((section) => section.title),
  );
  if (document.tableOfContents.entries.length !== expectedTableOfContentsEntries.length) {
    addIssue(
      context,
      ["tableOfContents", "entries"],
      "table of contents must contain every fixed and additional business section",
    );
  }
  for (const [index, entry] of document.tableOfContents.entries.entries()) {
    if (entry !== expectedTableOfContentsEntries[index]) {
      addIssue(context, ["tableOfContents", "entries", index], `table of contents entry must be ${expectedTableOfContentsEntries[index]}`);
    }
  }

  for (const [index, row] of document.sections.introduction.usageScenarios.channelTable.rows.entries()) {
    if (row.sequence !== index + 1 || row.channel !== prdChannelKinds[index]) {
      addIssue(context, ["sections", "introduction", "usageScenarios", "channelTable", "rows", index], "channel rows must contain the three canonical channels in order");
    }
  }
  const usageScenarioEvidence = document.sections.introduction.usageScenarios.blocks
    .flatMap(prdBlockEvidenceSegments);
  for (const [index, row] of document.sections.introduction.usageScenarios.channelTable.rows.entries()) {
    const rule = prdChannelEvidenceRules[row.channel];
    const hasPositiveFact = hasAffirmativeEvidence(usageScenarioEvidence, rule);
    const hasNegativeFact = rule.negative
      ? usageScenarioEvidence.some((segment) => rule.negative?.test(segment))
      : false;
    if (row.enabled && !hasPositiveFact) {
      addIssue(context, ["sections", "introduction", "usageScenarios", "channelTable", "rows", index, "enabled"], `enabled channel ${prdChannelLabels[row.channel]} requires an affirmative fact in the usage-scenario body`);
    }
    if (row.enabled && hasNegativeFact) {
      addIssue(context, ["sections", "introduction", "usageScenarios", "channelTable", "rows", index, "enabled"], `enabled channel ${prdChannelLabels[row.channel]} contradicts a negative usage-scenario fact`);
    }
    if (!row.enabled && hasPositiveFact) {
      addIssue(context, ["sections", "introduction", "usageScenarios", "channelTable", "rows", index, "enabled"], `disabled channel ${prdChannelLabels[row.channel]} contradicts an affirmative usage-scenario fact`);
    }
  }

  const diagrams = document.sections.businessRequirements.flowAndPages.diagrams;
  const expectedDiagrams = [
    { kind: "productFlow", title: "图1 产品流程图" },
    { kind: "productArchitecture", title: "图2 产品架构图" },
  ] as const;
  for (const [diagramIndex, diagram] of diagrams.entries()) {
    const expected = expectedDiagrams[diagramIndex];
    if (!expected || diagram.kind !== expected.kind || diagram.title !== expected.title) {
      addIssue(context, ["sections", "businessRequirements", "flowAndPages", "diagrams", diagramIndex], "diagrams must contain product flow followed by product architecture");
    }
    const nodeIds = new Set(diagram.nodes.map((node) => node.id));
    if (nodeIds.size !== diagram.nodes.length) {
      addIssue(context, ["sections", "businessRequirements", "flowAndPages", "diagrams", diagramIndex, "nodes"], "diagram node ids must be unique");
    }
    const edgeIds = diagram.edges.map((edge) => edge.id);
    for (const duplicate of duplicateValues(edgeIds)) {
      addIssue(context, ["sections", "businessRequirements", "flowAndPages", "diagrams", diagramIndex, "edges"], `duplicate diagram edge: ${duplicate}`);
    }
    for (const [edgeIndex, edge] of diagram.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        addIssue(context, ["sections", "businessRequirements", "flowAndPages", "diagrams", diagramIndex, "edges", edgeIndex], "diagram edges must reference declared nodes");
      }
      if (edge.from === edge.to) {
        addIssue(context, ["sections", "businessRequirements", "flowAndPages", "diagrams", diagramIndex, "edges", edgeIndex], "diagram edges cannot be self-referential");
      }
    }
  }

  for (const [index, row] of document.sections.safetyBaseline.rows.entries()) {
    if (row.sequence !== index + 1 || row.sequence !== prdSafetyBaselineItems[index]?.sequence) {
      addIssue(context, ["sections", "safetyBaseline", "rows", index, "sequence"], "safety baseline rows must contain sequences 1 through 21 in order");
    }
  }
  const safetyEvidenceSegments = requirementEvidenceSegments(document);
  for (const [index, row] of document.sections.safetyBaseline.rows.entries()) {
    if (row.applicability !== "不涉及" && !row.remarks) {
      addIssue(context, ["sections", "safetyBaseline", "rows", index, "remarks"], "a safety row marked 是 or 否 must include its requirement evidence or remediation note");
    }
    const evidenceRule = prdV2SafetyEvidenceRules[row.sequence];
    if (row.applicability === "不涉及") {
      if (hasAffirmativeEvidence(safetyEvidenceSegments, evidenceRule)) {
        addIssue(context, ["sections", "safetyBaseline", "rows", index, "applicability"], "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body");
      }
      continue;
    }
    if (!hasAffirmativeEvidence(safetyEvidenceSegments, evidenceRule)) {
      addIssue(context, ["sections", "safetyBaseline", "rows", index, "applicability"], "a safety row marked 是 or 否 requires affirmative semantic evidence in the requirement body");
    }
    if (row.applicability === "否" && !safetyEvidenceSegments.some((segment) => (
      isAffirmativeEvidenceSegment(segment, evidenceRule)
      && prdV2SafetyRemediationPattern.test(segment)
    ))) {
      addIssue(context, ["sections", "safetyBaseline", "rows", index, "applicability"], "a safety row marked 否 requires a concrete remediation for the same safety topic in the requirement body");
    }
  }

  const degradationText = inlinePlainText(document.sections.degradation.content).trim();
  if (!document.sections.degradation.applicable && degradationText !== "不涉及") {
    addIssue(context, ["sections", "degradation", "content"], "a non-applicable degradation plan must contain only 不涉及");
  }
  if (document.sections.degradation.applicable) {
    const chineseCharacterCount = [...degradationText.matchAll(/[\u3400-\u9fff]/gu)].length;
    if (chineseCharacterCount < 100) {
      addIssue(context, ["sections", "degradation", "content"], "an applicable degradation plan must contain at least 100 Chinese characters");
    }
  }

  const sectionEntries: Array<readonly [string, z.infer<typeof prdV2SectionSchema>]> = [
    ["background", document.sections.introduction.background],
    ["scope", document.sections.introduction.scope],
    ["usageScenarios", document.sections.introduction.usageScenarios],
    ["pageLinks", document.sections.businessRequirements.pageLinks],
    ["coreRules", document.sections.businessRequirements.coreRules],
    ["flowAndPages", document.sections.businessRequirements.flowAndPages],
    ["acceptanceCriteria", document.sections.businessRequirements.acceptanceCriteria],
    ...document.sections.businessRequirements.additionalSections.map((section, index) => (
      [`additionalSections.${index}`, section] as const
    )),
  ];
  const allBlocks = sectionEntries.flatMap(([, section]) => section.blocks);
  const allIds = [
    document.documentId,
    ...document.assumptions.map((assumption) => assumption.id),
    ...document.citations.map((citation) => citation.id),
  ];
  for (const block of allBlocks) {
    allIds.push(block.id);
    if (block.type === "bulletList" || block.type === "orderedList") {
      allIds.push(...block.items.map((item) => item.id));
    } else if (block.type === "table") {
      allIds.push(...block.columns.map((column) => column.id));
      allIds.push(...block.rows.map((row) => row.id));
    } else if (block.type === "flow") {
      allIds.push(...block.steps.map((step) => step.id));
    }
  }
  for (const diagram of diagrams) {
    allIds.push(diagram.id);
    allIds.push(...diagram.nodes.map((node) => node.id));
    allIds.push(...diagram.edges.map((edge) => edge.id));
  }
  for (const duplicate of duplicateValues(allIds)) {
    addIssue(context, [], `IR id must be globally unique: ${duplicate}`);
  }

  const acceptanceTable = document.sections.businessRequirements.acceptanceCriteria.blocks.find((block): block is z.infer<typeof prdTableBlockSchema> => (
    block.type === "table"
    && block.columns.length === 3
    && block.columns[0]?.label === "序号"
    && block.columns[1]?.label === "验收项"
    && block.columns[2]?.label === "验收标准"
  ));
  if (!acceptanceTable) {
    addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], "acceptance criteria must contain a 序号/验收项/验收标准 table");
  } else {
    const [sequenceColumn, itemColumn, standardColumn] = acceptanceTable.columns;
    const normalizedItems: string[] = [];
    const normalizedStandards: string[] = [];
    const itemTexts: string[] = [];
    for (const [rowIndex, row] of acceptanceTable.rows.entries()) {
      const cellText = (columnId: string | undefined) => inlinePlainText(
        row.cells.find((cell) => cell.columnId === columnId)?.content ?? [],
      ).replace(/\s+/gu, "").trim();
      const sequence = cellText(sequenceColumn?.id);
      const item = cellText(itemColumn?.id);
      const standard = cellText(standardColumn?.id);
      itemTexts.push(item);
      normalizedItems.push(normalizeSemanticText(item));
      normalizedStandards.push(normalizeSemanticText(standard));
      if (sequence !== String(rowIndex + 1)) {
        addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks", "rows", rowIndex], "acceptance row sequence must be continuous starting at 1");
      }
      if ([...item].length < 2 || [...standard].length < 10) {
        addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks", "rows", rowIndex], "acceptance rows must name a concrete item and a substantive testable standard");
      }
    }
    for (const duplicate of duplicateValues(normalizedItems.filter(Boolean))) {
      addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], `acceptance items must be distinct: ${duplicate}`);
    }
    for (const duplicate of duplicateValues(normalizedStandards.filter(Boolean))) {
      addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], `acceptance standards must be distinct: ${duplicate}`);
    }
    const acceptanceEvidenceSegments = acceptanceRelevanceEvidenceSegments(document);
    const relevantDimensions = prdV2AcceptanceDimensions.filter((dimension) => (
      hasAffirmativeEvidence(acceptanceEvidenceSegments, { positive: dimension.relevancePattern })
    ));
    if (acceptanceTable.rows.length < relevantDimensions.length) {
      addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], `acceptance criteria must contain at least ${relevantDimensions.length} independently testable rows for the relevant requirement dimensions`);
    }
    const dimensionRows = relevantDimensions.map((dimension) => (
      itemTexts.flatMap((item, rowIndex) => dimension.pattern.test(item) ? [rowIndex] : [])
    ));
    for (const [dimensionIndex, rows] of dimensionRows.entries()) {
      if (rows.length === 0) {
        addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], `acceptance criteria must cover ${relevantDimensions[dimensionIndex]?.label}`);
      }
    }
    if (dimensionRows.every((rows) => rows.length > 0) && !hasDistinctAcceptanceCoverage(dimensionRows)) {
      addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks"], "acceptance dimensions must be represented by distinct rows");
    }
  }
  if (!document.sections.businessRequirements.coreRules.blocks.some((block) => block.type === "table" || block.type === "requirement")) {
    addIssue(context, ["sections", "businessRequirements", "coreRules", "blocks"], "core rules must contain a rule table or typed requirement");
  }
  if (!document.sections.introduction.scope.blocks.some((block) => block.type === "bulletList" || block.type === "orderedList")) {
    addIssue(context, ["sections", "introduction", "scope", "blocks"], "document scope must contain an explicit list");
  }
  for (const [blockIndex, block] of allBlocks.entries()) {
    if (block.type === "table") {
      if (isSemanticChannelTable(block)) {
        addIssue(context, ["sections", "blocks", blockIndex], "use the single typed channelTable instead of another channel table");
      }
      const columnIds = block.columns.map((column) => column.id);
      for (const duplicate of duplicateValues(columnIds)) {
        addIssue(context, ["sections", "blocks", blockIndex, "columns"], `duplicate table column: ${duplicate}`);
      }
      for (const [rowIndex, row] of block.rows.entries()) {
        const cellIds = row.cells.map((cell) => cell.columnId);
        if (duplicateValues(cellIds).length > 0 || cellIds.length !== columnIds.length || cellIds.some((id) => !columnIds.includes(id))) {
          addIssue(context, ["sections", "blocks", blockIndex, "rows", rowIndex, "cells"], "each table row must contain exactly one cell for every column");
        }
      }
    }
  }

  const citations = new Set(document.citations.map((citation) => citation.id));
  const assumptions = new Set(document.assumptions.map((assumption) => assumption.id));
  for (const [index, assumption] of document.assumptions.entries()) {
    if (assumption.introducedInRevision > document.revision.number) {
      addIssue(context, ["assumptions", index, "introducedInRevision"], "assumption cannot be introduced after the current revision");
    }
    for (const citationId of assumption.citationIds) {
      if (!citations.has(citationId)) addIssue(context, ["assumptions", index, "citationIds"], `unknown citation: ${citationId}`);
    }
  }
  const goals = allBlocks.filter((block): block is z.infer<typeof prdGoalBlockSchema> => block.type === "goal");
  const requirements = allBlocks.filter((block): block is z.infer<typeof prdRequirementBlockSchema> => block.type === "requirement");
  const criteria = allBlocks.filter((block): block is z.infer<typeof prdAcceptanceCriterionBlockSchema> => block.type === "acceptanceCriterion");
  const flows = allBlocks.filter((block): block is z.infer<typeof prdFlowBlockSchema> => block.type === "flow");
  const goalIds = new Set(goals.map((goal) => goal.id));
  const requirementIds = new Set(requirements.map((requirement) => requirement.id));
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const flowIds = new Set(flows.map((flow) => flow.id));
  for (const [index, requirement] of requirements.entries()) {
    for (const duplicate of duplicateValues([...requirement.goalIds, ...requirement.acceptanceCriterionIds])) {
      addIssue(context, ["sections", "businessRequirements", "coreRules", "blocks", index], `duplicate requirement reference: ${duplicate}`);
    }
    for (const goalId of requirement.goalIds) {
      if (!goalIds.has(goalId)) {
        addIssue(context, ["sections", "businessRequirements", "coreRules", "blocks", index, "goalIds"], `unknown goal: ${goalId}`);
      }
    }
    for (const criterionId of requirement.acceptanceCriterionIds) {
      const criterion = criteria.find((candidate) => candidate.id === criterionId);
      if (!criterion) {
        addIssue(context, ["sections", "businessRequirements", "coreRules", "blocks", index, "acceptanceCriterionIds"], `unknown acceptance criterion: ${criterionId}`);
      } else if (!criterion.requirementIds.includes(requirement.id)) {
        addIssue(context, ["sections", "businessRequirements", "coreRules", "blocks", index, "acceptanceCriterionIds"], `acceptance criterion ${criterionId} must reference requirement ${requirement.id}`);
      }
    }
  }
  for (const [index, criterion] of criteria.entries()) {
    for (const requirementId of criterion.requirementIds) {
      const requirement = requirements.find((candidate) => candidate.id === requirementId);
      if (!requirement) {
        addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks", index, "requirementIds"], `unknown requirement: ${requirementId}`);
      } else if (!requirement.acceptanceCriterionIds.includes(criterion.id)) {
        addIssue(context, ["sections", "businessRequirements", "acceptanceCriteria", "blocks", index, "requirementIds"], `requirement ${requirementId} must reference acceptance criterion ${criterion.id}`);
      }
    }
  }
  for (const [flowIndex, flow] of flows.entries()) {
    for (const [stepIndex, step] of flow.steps.entries()) {
      for (const requirementId of step.requirementIds) {
        if (!requirementIds.has(requirementId)) {
          addIssue(context, ["sections", "businessRequirements", "flowAndPages", "blocks", flowIndex, "steps", stepIndex, "requirementIds"], `unknown requirement: ${requirementId}`);
        }
      }
    }
  }
  const sectionIds = new Set([
    "introduction", "background", "scope", "usageScenarios", "businessRequirements",
    "pageLinks", "coreRules", "flowAndPages", "acceptanceCriteria", "degradation", "safetyBaseline",
  ]);
  const referenceSets = {
    section: sectionIds,
    goal: goalIds,
    requirement: requirementIds,
    acceptanceCriterion: criterionIds,
    flow: flowIds,
    assumption: assumptions,
  };
  for (const block of allBlocks) {
    for (const content of blockInlines(block)) {
      for (const inline of content) {
        if (inline.type === "citation" && !citations.has(inline.citationId)) {
          addIssue(context, ["sections"], `unknown citation: ${inline.citationId}`);
        } else if (inline.type === "reference" && !referenceSets[inline.targetType].has(inline.targetId)) {
          addIssue(context, ["sections"], `unknown ${inline.targetType} reference: ${inline.targetId}`);
        }
      }
    }
  }

  for (const placeholder of prdV2ForbiddenPlaceholders) {
    if (stringValues(document).some((value) => value.includes(placeholder))) {
      addIssue(context, [], `PRD must not contain placeholder wording: ${placeholder}`);
    }
  }
  for (const pattern of prdV2ForbiddenPlaceholderPatterns) {
    if (stringValues(document).some((value) => pattern.test(value))) {
      addIssue(context, [], `PRD must not contain placeholder wording matching ${pattern.source}`);
    }
  }
  for (const pattern of prdV2WeakStandalonePatterns) {
    if (stringValues(document).some((value) => pattern.test(value.trim()))) {
      addIssue(context, [], `PRD must spell out inherited or changed behavior instead of using ${pattern.source}`);
    }
  }
  for (const [blockIndex, block] of allBlocks.entries()) {
    if (block.type === "heading" && prdV2StandaloneApiHeadingPattern.test(inlinePlainText(block.content).trim())) {
      addIssue(context, ["sections", "blocks", blockIndex], "PRD must not contain a standalone interface or API chapter");
    }
  }
});

function inlinePlainText(inlines: readonly z.infer<typeof prdInlineSchema>[]) {
  return inlines.map((inline) => {
    if (inline.type === "citation") return inline.label ?? "";
    if (inline.type === "reference") return inline.label ?? "";
    return inline.text;
  }).join("");
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

function splitEvidenceText(value: string): string[] {
  return value
    .split(/[。！？；;\n]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function prdBlockEvidenceSegments(block: z.infer<typeof prdBlockSchema>): string[] {
  const values: string[] = [];
  switch (block.type) {
    case "paragraph":
    case "heading":
      values.push(inlinePlainText(block.content));
      break;
    case "callout":
      values.push(block.title ?? "", inlinePlainText(block.content));
      break;
    case "bulletList":
    case "orderedList":
      values.push(...block.items.map((item) => inlinePlainText(item.content)));
      break;
    case "table":
      values.push(...block.rows.flatMap((row) => row.cells.map((cell) => inlinePlainText(cell.content))));
      break;
    case "goal":
      values.push(block.title, inlinePlainText(block.description), block.successMetric);
      break;
    case "persona":
      values.push(block.name, inlinePlainText(block.description), ...block.needs, ...block.painPoints);
      break;
    case "requirement":
      values.push(block.title, inlinePlainText(block.description));
      break;
    case "acceptanceCriterion":
      values.push(inlinePlainText(block.given), inlinePlainText(block.when), inlinePlainText(block.then));
      break;
    case "flow":
      values.push(block.title, block.actor, block.trigger, ...block.steps.map((step) => step.text), block.outcome);
      break;
    case "risk":
      values.push(inlinePlainText(block.description), inlinePlainText(block.mitigation));
      break;
  }
  return values.flatMap(splitEvidenceText);
}

function requirementEvidenceSegments(document: z.infer<typeof prdDocumentV2Schema>): string[] {
  return prdV2BodyEvidenceSegments(document, true);
}

function acceptanceRelevanceEvidenceSegments(document: z.infer<typeof prdDocumentV2Schema>): string[] {
  return prdV2BodyEvidenceSegments(document, false);
}

function prdV2BodyEvidenceSegments(
  document: z.infer<typeof prdDocumentV2Schema>,
  includeAcceptanceCriteria: boolean,
): string[] {
  const blockSections: Array<z.infer<typeof prdV2SectionSchema>> = [
    document.sections.introduction.background,
    document.sections.introduction.scope,
    document.sections.introduction.usageScenarios,
    document.sections.businessRequirements.pageLinks,
    document.sections.businessRequirements.coreRules,
    document.sections.businessRequirements.flowAndPages,
    ...document.sections.businessRequirements.additionalSections,
  ];
  if (includeAcceptanceCriteria) {
    blockSections.push(document.sections.businessRequirements.acceptanceCriteria);
  }
  const diagrams = document.sections.businessRequirements.flowAndPages.diagrams;
  return [
    ...splitEvidenceText(inlinePlainText(document.sections.businessRequirements.summary)),
    ...blockSections.flatMap((section) => section.blocks.flatMap(prdBlockEvidenceSegments)),
    ...diagrams.flatMap((diagram) => [
      ...splitEvidenceText(diagram.description),
      ...diagram.nodes.flatMap((node) => splitEvidenceText(node.label)),
      ...diagram.edges.flatMap((edge) => edge.label ? splitEvidenceText(edge.label) : []),
    ]),
    ...splitEvidenceText(inlinePlainText(document.sections.degradation.content)),
  ];
}

function hasAffirmativeEvidence(segments: readonly string[], rule: PrdV2EvidenceRule): boolean {
  return segments.some((segment) => isAffirmativeEvidenceSegment(segment, rule));
}

function isAffirmativeEvidenceSegment(segment: string, rule: PrdV2EvidenceRule): boolean {
  return (
    rule.positive.test(segment)
    && !(rule.negative?.test(segment) ?? false)
  );
}

function normalizeSemanticText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function hasDistinctAcceptanceCoverage(dimensionRows: readonly (readonly number[])[]): boolean {
  const ordered = [...dimensionRows].sort((left, right) => left.length - right.length);
  const usedRows = new Set<number>();
  const assign = (dimensionIndex: number): boolean => {
    if (dimensionIndex === ordered.length) return true;
    for (const rowIndex of ordered[dimensionIndex] ?? []) {
      if (usedRows.has(rowIndex)) continue;
      usedRows.add(rowIndex);
      if (assign(dimensionIndex + 1)) return true;
      usedRows.delete(rowIndex);
    }
    return false;
  };
  return assign(0);
}

function isSemanticChannelTable(block: z.infer<typeof prdTableBlockSchema>): boolean {
  const columnText = block.columns.map((column) => column.label).join(" ");
  const cellText = block.rows
    .flatMap((row) => row.cells.map((cell) => inlinePlainText(cell.content)))
    .join(" ");
  const hasChannelAxis = /渠道/u.test(columnText)
    || /(?:端内渠道|WAP\/?H5|H5端外渠道|小程序)/iu.test(cellText);
  const hasSelectionAxis = /(?:是否|投放|启用|选择|勾选|开关)/u.test(columnText)
    || /(?:☑|□|启用|不启用|投放|不投放)/u.test(cellText);
  return hasChannelAxis && hasSelectionAxis;
}

export type PrdDocumentV1 = z.infer<typeof prdDocumentV1Schema>;
export type PrdDocumentV2 = z.infer<typeof prdDocumentV2Schema>;
export type PrdDocument = PrdDocumentV1 | PrdDocumentV2;
export const prdDocumentSchema: z.ZodType<PrdDocument, z.ZodTypeDef, unknown> = z.union([
  prdDocumentV1Schema,
  prdDocumentV2Schema,
]);
export type PrdBlock = z.infer<typeof prdBlockSchema>;
export type PrdInline = z.infer<typeof prdInlineSchema>;
export type PrdSectionKey = z.infer<typeof prdSectionKeySchema>;

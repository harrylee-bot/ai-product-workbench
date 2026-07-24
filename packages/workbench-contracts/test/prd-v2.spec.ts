import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import {
  artifactVersionInlineDetailSchema,
  createArtifactVersionRequestSchema,
  prdDocumentSchema,
  prdDocumentV2Schema,
  runtimePrdDocumentV2Schema,
  prdTableOfContentsEntriesFor,
  runtimeResultSchema,
} from "../src/index.js";
import { prdDocumentV2Example } from "../src/prd-example.js";

function cloneExample() {
  return structuredClone(prdDocumentV2Example);
}

function acceptanceTable(document: ReturnType<typeof cloneExample>) {
  const table = document.sections.businessRequirements.acceptanceCriteria.blocks.find((block) => block.type === "table");
  if (!table || table.type !== "table") throw new Error("missing fixture table");
  return table;
}

function text(value: string) {
  return [{ type: "text" as const, text: value, marks: [] }];
}

function withAdditionalBusinessSections(...titles: string[]) {
  const document = cloneExample();
  document.sections.businessRequirements.additionalSections = titles.map((title, index) => ({
    title,
    blocks: [{
      id: `additional-business-section-${index + 5}`,
      type: "paragraph" as const,
      content: text(`补充说明第 ${index + 5} 项业务约束及其可验收结果。`),
    }],
  }));
  document.tableOfContents.entries = prdTableOfContentsEntriesFor(titles);
  return document;
}

const affirmativeSafetyFacts = [
  "本需求修改现有功能逻辑。",
  "本页面面向公众用户开放访问。",
  "本需求新增公网访问入口。",
  "管理后台展示手机号等个人信息并执行脱敏，支持受控导出。",
  "管理后台操作页面启用包含姓名、手机号和操作时间的水印。",
  "管理后台查询页面要求输入查询条件后查询数据。",
  "管理后台接入 4A 统一身份管理并保留日志。",
  "管理后台尚未接入 4A，当前使用独立账号体系。",
  "后台配置内容启用敏感词过滤。",
  "后台配置内容在前台展示并执行先审后发。",
  "页面展示隐私政策并在采集前取得用户同意。",
  "业务运行于微信小程序并提供小程序页面入口。",
  "页面采集身份证号码并在提交前获取主动授权。",
  "页面启用一键登录并在登录前取得用户同意。",
  "用户操作后跳转第三方应用页面。",
  "系统与第三方公司进行接口对接和数据交互。",
  "本需求新增 API 接口并完成 API 台账填报。",
  "系统通过跨系统接口调用传输敏感信息，并采用接口鉴权和加密传输。",
  "系统落库存储用户信息并进行加密保护。",
  "系统采集业务数据，并明确采集方式、渠道、格式和流程。",
  "提交信息和任务状态执行完整性与一致性校验。",
] as const;

const negativeOrAbsentSafetyFacts = [
  "本需求不涉及功能逻辑变更。",
  "本需求仅限内部员工使用，不面向公众用户。",
  "本需求不新增公网访问入口。",
  "本需求不采集或展示个人信息。",
  "本需求不涉及管理后台水印。",
  "本需求不涉及后台查询页面。",
  "本需求不涉及管理后台身份管理。",
  null,
  "本需求不涉及后台配置或敏感词过滤。",
  "本需求不涉及后台配置内容的前台展示。",
  "本需求不涉及隐私政策或隐私协议变更。",
  "本需求不启用 APP 或小程序。",
  "本需求不采集身份证、银行卡或生物识别信息。",
  "本需求不启用一键登录或免密登录。",
  "本需求不跳转第三方页面或应用。",
  "本需求不与第三方公司进行接口对接。",
  "本需求不新增 API 接口。",
  "本需求不涉及敏感信息或跨系统调用。",
  "本需求不存储用户信息或重要数据。",
  "本需求不采集用户数据。",
  "本需求无需校验数据完整性与一致性。",
] as const;

function withoutSafetyEvidence() {
  const document = cloneExample();
  document.sections.introduction.background.blocks[0] = {
    id: "background-main",
    type: "paragraph",
    content: text("现有产品工作台提供业务处理能力，本需求用于明确业务目标和执行边界。"),
  };
  document.sections.businessRequirements.coreRules.blocks = document.sections.businessRequirements.coreRules.blocks
    .filter((block) => block.id !== "safety-facts");
  for (const row of document.sections.safetyBaseline.rows) {
    row.applicability = "不涉及";
    row.remarks = null;
  }
  return document;
}

function replaceBodyTerms(value: unknown, replacements: readonly (readonly [RegExp, string])[]): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceBodyTerms(item, replacements);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      (value as Record<string, unknown>)[key] = replacements.reduce(
        (result, [pattern, replacement]) => result.replace(pattern, replacement),
        child,
      );
    } else {
      replaceBodyTerms(child, replacements);
    }
  }
}

function withoutEmptyOrFailureRequirements() {
  const document = cloneExample();
  const replacements = [
    [/(?:空态|空状态|暂无|无数据|尚未提交)/gu, "初始提示"],
    [/(?:失败|异常|错误|重试|恢复|降级)/gu, "继续处理"],
  ] as const;
  replaceBodyTerms(document.sections.introduction, replacements);
  replaceBodyTerms(document.sections.businessRequirements.summary, replacements);
  replaceBodyTerms(document.sections.businessRequirements.pageLinks, replacements);
  replaceBodyTerms(document.sections.businessRequirements.coreRules, replacements);
  replaceBodyTerms(document.sections.businessRequirements.flowAndPages, replacements);
  document.sections.degradation.applicable = false;
  document.sections.degradation.content = text("不涉及");

  const table = acceptanceTable(document);
  table.rows = table.rows.filter((row) => {
    const item = row.cells.find((cell) => cell.columnId === table.columns[1]?.id);
    return !/(?:空态|空状态|暂无|无数据|尚未提交|失败|异常|错误|重试|恢复|降级)/u.test(
      item?.content.map((inline) => inline.type === "text" || inline.type === "link" ? inline.text : inline.label ?? "").join("") ?? "",
    );
  });
  for (const [index, row] of table.rows.entries()) {
    const sequence = row.cells.find((cell) => cell.columnId === table.columns[0]?.id);
    if (sequence) sequence.content = text(String(index + 1));
  }
  return document;
}

function withoutPermissionOrStateRequirements() {
  const document = cloneExample();
  const replacements = [
    [/(?:权限|授权|无权)/gu, "资格"],
    [/(?:状态|流转)/gu, "阶段"],
    [/(?:提交|审核|发布|撤回|生效|下线)/gu, "处理"],
  ] as const;
  replaceBodyTerms(document.sections.introduction, replacements);
  replaceBodyTerms(document.sections.businessRequirements.summary, replacements);
  replaceBodyTerms(document.sections.businessRequirements.pageLinks, replacements);
  replaceBodyTerms(document.sections.businessRequirements.coreRules, replacements);
  replaceBodyTerms(document.sections.businessRequirements.flowAndPages.blocks, replacements);
  replaceBodyTerms(document.sections.businessRequirements.flowAndPages.diagrams, replacements);
  replaceBodyTerms(document.sections.degradation, replacements);

  const table = acceptanceTable(document);
  table.rows = table.rows.filter((row) => row.id !== "acceptance-permission" && row.id !== "acceptance-state");
  for (const [index, row] of table.rows.entries()) {
    const sequence = row.cells.find((cell) => cell.columnId === table.columns[0]?.id);
    if (sequence) sequence.content = text(String(index + 1));
  }
  return document;
}

const deployedRuntimeResultSchema = JSON.parse(readFileSync(
  new URL("../../../integrations/deerflow/skills/workbench/references/runtime-result.schema.json", import.meta.url),
  "utf8",
));
const deployedRuntimeResultValidator = new Validator(deployedRuntimeResultSchema, "2020-12");

describe("workbench.prd.v2", () => {
  it("accepts the complete fixed requirement-document structure", () => {
    const parsed = prdDocumentSchema.parse(prdDocumentV2Example);

    expect(parsed.protocol).toBe("workbench.prd.v2");
    if (parsed.protocol !== "workbench.prd.v2") throw new Error("unexpected protocol");
    expect(parsed.tableOfContents.entries).toHaveLength(11);
    expect(parsed.sections.introduction.usageScenarios.channelTable.rows).toHaveLength(3);
    expect(parsed.sections.businessRequirements.flowAndPages.diagrams.map((diagram) => diagram.kind)).toEqual([
      "productFlow",
      "productArchitecture",
    ]);
    expect(parsed.sections.safetyBaseline.rows).toHaveLength(21);
  });

  it("defaults legacy v2 documents to no additional business sections", () => {
    const legacy = cloneExample();
    delete (legacy.sections.businessRequirements as {
      additionalSections?: unknown;
    }).additionalSections;

    const parsed = prdDocumentV2Schema.parse(legacy);

    expect(parsed.sections.businessRequirements.additionalSections).toEqual([]);
    expect(parsed.tableOfContents.entries).toHaveLength(11);
    expect(deployedRuntimeResultValidator.validate({
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: legacy.title,
        operation: { kind: "create" },
        citations: [],
        content: legacy,
      }],
    }).valid).toBe(true);
  });

  it("accepts consecutive 2.5+ business sections and inserts them into the manual TOC", () => {
    const document = withAdditionalBusinessSections("2.5 配置规则", "2.6 结果说明");
    const parsed = prdDocumentV2Schema.parse(document);

    expect(parsed.sections.businessRequirements.additionalSections.map((section) => section.title)).toEqual([
      "2.5 配置规则",
      "2.6 结果说明",
    ]);
    expect(parsed.tableOfContents.entries.slice(8, 13)).toEqual([
      "2.4 验收标准",
      "2.5 配置规则",
      "2.6 结果说明",
      "3. 业务降级方案（必填）",
      "4. 需求安全基线要求（必填）",
    ]);
    expect(deployedRuntimeResultValidator.validate({
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: document.title,
        operation: { kind: "create" },
        citations: [],
        content: document,
      }],
    }).valid).toBe(true);
  });

  it("rejects non-consecutive additional business sections and TOC drift", () => {
    const numberingGap = withAdditionalBusinessSections("2.6 配置规则");
    expect(prdDocumentV2Schema.safeParse(numberingGap).success).toBe(false);

    const tocDrift = withAdditionalBusinessSections("2.5 配置规则");
    tocDrift.tableOfContents.entries[9] = "2.5 另一个标题";
    expect(prdDocumentV2Schema.safeParse(tocDrift).success).toBe(false);
  });

  it("includes additional business sections in IR uniqueness and semantic evidence validation", () => {
    const duplicateId = withAdditionalBusinessSections("2.5 配置规则");
    duplicateId.sections.businessRequirements.additionalSections[0]!.blocks[0]!.id = "background-main";
    expect(prdDocumentV2Schema.safeParse(duplicateId).success).toBe(false);

    const safetyEvidence = withAdditionalBusinessSections("2.5 接口规则");
    safetyEvidence.sections.businessRequirements.additionalSections[0]!.blocks[0] = {
      id: "additional-api-rule",
      type: "paragraph",
      content: text("本需求新增 API 接口并完成 API 台账填报。"),
    };
    expect(prdDocumentV2Schema.safeParse(safetyEvidence).success).toBe(false);

    safetyEvidence.sections.safetyBaseline.rows[16]!.applicability = "是";
    safetyEvidence.sections.safetyBaseline.rows[16]!.remarks = "新增 API 接口需要完成台账填报。";
    expect(prdDocumentV2Schema.safeParse(safetyEvidence).success).toBe(true);
  });

  it("rejects cover drift, channel drift, missing diagrams, and safety row drift", () => {
    const cover = cloneExample();
    cover.cover.title = "另一个标题需求说明书";
    expect(prdDocumentV2Schema.safeParse(cover).success).toBe(false);

    const channels = cloneExample();
    channels.sections.introduction.usageScenarios.channelTable.rows[1]!.channel = "miniProgram";
    expect(prdDocumentV2Schema.safeParse(channels).success).toBe(false);

    const diagrams = cloneExample();
    diagrams.sections.businessRequirements.flowAndPages.diagrams.pop();
    expect(prdDocumentV2Schema.safeParse(diagrams).success).toBe(false);

    const safety = cloneExample();
    safety.sections.safetyBaseline.rows[20]!.sequence = 20;
    expect(prdDocumentV2Schema.safeParse(safety).success).toBe(false);
  });

  it.each([
    ["document", (document: ReturnType<typeof cloneExample>) => {
      document.documentId = document.sections.introduction.background.blocks[0]!.id;
    }],
    ["block", (document: ReturnType<typeof cloneExample>) => {
      document.sections.introduction.background.blocks[0]!.id = document.documentId;
    }],
    ["list item", (document: ReturnType<typeof cloneExample>) => {
      const block = document.sections.introduction.scope.blocks.find((candidate) => candidate.type === "bulletList");
      if (!block || block.type !== "bulletList") throw new Error("missing fixture list");
      block.items[0]!.id = document.documentId;
    }],
    ["table column across tables", (document: ReturnType<typeof cloneExample>) => {
      const rulesTable = document.sections.businessRequirements.coreRules.blocks.find((candidate) => candidate.type === "table");
      const criteriaTable = acceptanceTable(document);
      if (!rulesTable || rulesTable.type !== "table") throw new Error("missing fixture rules table");
      const duplicateId = rulesTable.columns[0]!.id;
      const originalId = criteriaTable.columns[0]!.id;
      criteriaTable.columns[0]!.id = duplicateId;
      for (const row of criteriaTable.rows) {
        const cell = row.cells.find((candidate) => candidate.columnId === originalId);
        if (cell) cell.columnId = duplicateId;
      }
    }],
    ["table row across tables", (document: ReturnType<typeof cloneExample>) => {
      const rulesTable = document.sections.businessRequirements.coreRules.blocks.find((candidate) => candidate.type === "table");
      const criteriaTable = acceptanceTable(document);
      if (!rulesTable || rulesTable.type !== "table") throw new Error("missing fixture rules table");
      criteriaTable.rows[0]!.id = rulesTable.rows[0]!.id;
    }],
    ["flow step", (document: ReturnType<typeof cloneExample>) => {
      const flow = document.sections.businessRequirements.flowAndPages.blocks.find((candidate) => candidate.type === "flow");
      if (!flow || flow.type !== "flow") throw new Error("missing fixture flow");
      flow.steps[0]!.id = document.documentId;
    }],
    ["assumption", (document: ReturnType<typeof cloneExample>) => {
      document.assumptions[0]!.id = document.documentId;
    }],
    ["citation", (document: ReturnType<typeof cloneExample>) => {
      document.citations.push({
        id: document.documentId,
        documentId: "source-document",
        chunkId: "source-chunk",
        sourcePath: "storage/source.md",
        title: "Source",
        quote: "Source evidence",
        locator: { heading: "Evidence", startLine: 1, endLine: 1 },
      });
    }],
    ["diagram", (document: ReturnType<typeof cloneExample>) => {
      document.sections.businessRequirements.flowAndPages.diagrams[0]!.id = document.documentId;
    }],
    ["diagram node across diagrams", (document: ReturnType<typeof cloneExample>) => {
      const [first, second] = document.sections.businessRequirements.flowAndPages.diagrams;
      const duplicateId = first!.nodes[0]!.id;
      const originalId = second!.nodes[0]!.id;
      second!.nodes[0]!.id = duplicateId;
      for (const edge of second!.edges) {
        if (edge.from === originalId) edge.from = duplicateId;
        if (edge.to === originalId) edge.to = duplicateId;
      }
    }],
    ["diagram edge across diagrams", (document: ReturnType<typeof cloneExample>) => {
      const [first, second] = document.sections.businessRequirements.flowAndPages.diagrams;
      second!.edges[0]!.id = first!.edges[0]!.id;
    }],
  ])("rejects a globally duplicated %s IR id", (_label, mutate) => {
    const document = cloneExample();
    mutate(document);

    const result = prdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.startsWith("IR id must be globally unique:"))).toBe(true);
    }
  });

  it("rejects placeholders, an incomplete acceptance table, and a vague degradation plan", () => {
    const placeholder = cloneExample();
    placeholder.sections.introduction.background.blocks[0] = {
      id: "background-main",
      type: "paragraph",
      content: [{ type: "text", text: "页面地址待确认。", marks: [] }],
    };
    expect(prdDocumentV2Schema.safeParse(placeholder).success).toBe(false);

    const acceptance = cloneExample();
    const table = acceptance.sections.businessRequirements.acceptanceCriteria.blocks.find((block) => block.type === "table");
    if (!table || table.type !== "table") throw new Error("missing fixture table");
    table.columns[1]!.label = "检查项";
    expect(prdDocumentV2Schema.safeParse(acceptance).success).toBe(false);

    const degradation = cloneExample();
    degradation.sections.degradation.content = [{ type: "text", text: "失败后重试。", marks: [] }];
    expect(prdDocumentV2Schema.safeParse(degradation).success).toBe(false);
  });

  it("rejects shallow acceptance rows, unsupported safety claims, and duplicate channel tables", () => {
    const acceptance = cloneExample();
    const table = acceptanceTable(acceptance);
    table.rows.splice(1);
    table.rows[0]!.cells[0]!.content = text("甲");
    table.rows[0]!.cells[2]!.content = text("正常");
    expect(prdDocumentV2Schema.safeParse(acceptance).success).toBe(false);

    const safety = cloneExample();
    for (const row of safety.sections.safetyBaseline.rows) {
      row.applicability = "是";
      row.remarks = "已检查。";
    }
    expect(prdDocumentV2Schema.safeParse(safety).success).toBe(false);

    const duplicateChannel = cloneExample();
    duplicateChannel.sections.businessRequirements.coreRules.blocks.push({
      id: "duplicate-channel-table",
      type: "table",
      columns: [
        { id: "duplicate-channel", label: "投放渠道" },
        { id: "duplicate-selection", label: "选择" },
      ],
      rows: [{
        id: "duplicate-channel-row",
        cells: [
          { columnId: "duplicate-channel", content: [{ type: "text", text: "端内", marks: [] }] },
          { columnId: "duplicate-selection", content: [{ type: "text", text: "是", marks: [] }] },
        ],
      }],
    });
    expect(prdDocumentV2Schema.safeParse(duplicateChannel).success).toBe(false);
  });

  it("requires affirmative body evidence for every involved safety row", () => {
    const disabledChannel = cloneExample();
    disabledChannel.sections.safetyBaseline.rows[11] = {
      sequence: 12,
      applicability: "是",
      remarks: "已检查双清单要求。",
    };
    expect(prdDocumentV2Schema.safeParse(disabledChannel).success).toBe(false);

    const negatedChannel = cloneExample();
    negatedChannel.sections.introduction.usageScenarios.blocks[0] = {
      id: "usage-main",
      type: "paragraph",
      content: text("用户从产品工作台端内入口发起任务，本需求不涉及小程序。"),
    };
    negatedChannel.sections.safetyBaseline.rows[11] = {
      sequence: 12,
      applicability: "是",
      remarks: "已检查双清单要求。",
    };
    expect(prdDocumentV2Schema.safeParse(negatedChannel).success).toBe(false);

    const assumptionOnly = cloneExample();
    assumptionOnly.assumptions.push({
      id: "assumption-api",
      statement: "默认本需求新增 API 接口。",
      status: "open",
      impact: "high",
      owner: "研发负责人",
      introducedInRevision: 1,
      citationIds: [],
    });
    assumptionOnly.sections.safetyBaseline.rows[16] = {
      sequence: 17,
      applicability: "是",
      remarks: "已完成 API 台账填报。",
    };
    expect(prdDocumentV2Schema.safeParse(assumptionOnly).success).toBe(false);

    const supportedApi = cloneExample();
    supportedApi.sections.businessRequirements.coreRules.blocks.push({
      id: "api-safety-fact",
      type: "paragraph",
      content: text("本需求新增 API 接口，并已完成 API 台账填报。"),
    });
    supportedApi.sections.safetyBaseline.rows[16] = {
      sequence: 17,
      applicability: "是",
      remarks: "新增 API 已完成台账填报。",
    };
    expect(prdDocumentV2Schema.safeParse(supportedApi).success).toBe(true);
  });

  it("requires a concrete body remediation when a safety row is marked no", () => {
    const missingRemediation = cloneExample();
    missingRemediation.sections.businessRequirements.coreRules.blocks.push({
      id: "api-fact-only",
      type: "paragraph",
      content: text("本需求新增 API 接口。"),
    });
    missingRemediation.sections.safetyBaseline.rows[16] = {
      sequence: 17,
      applicability: "否",
      remarks: "API 台账尚未完成。",
    };
    expect(prdDocumentV2Schema.safeParse(missingRemediation).success).toBe(false);

    const remediated = cloneExample();
    remediated.sections.businessRequirements.coreRules.blocks.push({
      id: "api-remediation",
      type: "paragraph",
      content: text("本需求新增 API 接口，上线前需补充 API 台账填报并完成安全评审。"),
    });
    remediated.sections.safetyBaseline.rows[16] = {
      sequence: 17,
      applicability: "否",
      remarks: "当前未完成台账，按正文方案上线前整改。",
    };
    expect(prdDocumentV2Schema.safeParse(remediated).success).toBe(true);
  });

  it("requires null remarks for non-applicable safety rows on newly created PRDs", () => {
    const document = cloneExample();
    document.sections.safetyBaseline.rows[2]!.remarks = "本需求不涉及 App 或小程序。";
    const candidate = {
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: document.title,
        operation: { kind: "create" },
        citations: document.citations,
        content: document,
      }],
    };

    expect(prdDocumentV2Schema.safeParse(document).success).toBe(true);
    const result = runtimeResultSchema.safeParse(candidate);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["artifacts", 0, "content", "sections", "safetyBaseline", "rows", 2, "remarks"],
          message: "A newly created PRD safety row marked 不涉及 must use null remarks",
        }),
      ]));
    }
  });

  it("rejects 不涉及 for all 21 safety rows when the body contains affirmative evidence", () => {
    expect(affirmativeSafetyFacts).toHaveLength(21);

    for (const [index, fact] of affirmativeSafetyFacts.entries()) {
      const document = withoutSafetyEvidence();
      document.sections.businessRequirements.coreRules.blocks.push({
        id: `safety-evidence-${index + 1}`,
        type: "paragraph",
        content: text(fact),
      });

      const result = index === 0
        ? runtimePrdDocumentV2Schema.safeParse(document)
        : prdDocumentV2Schema.safeParse(document);
      expect(result.success, `safety row ${index + 1}`).toBe(false);
      if (!result.success) {
        expect(result.error.issues, `safety row ${index + 1}`).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: ["sections", "safetyBaseline", "rows", index, "applicability"],
            message: index === 0
              ? "safety row 1 marked 不涉及 contradicts a requested function, page, interface, or logic change"
              : "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
          }),
        ]));
      }
    }
  });

  it("treats building a business capability as safety row 1 evidence", () => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "production-capability-build",
      type: "paragraph",
      content: text("本次建设“电商订单状态通知设置”能力，支持端内通知开关、订单状态分类、发送结果记录、失败重试与权限反馈。"),
    });

    expect(prdDocumentV2Schema.safeParse(document).success).toBe(true);
    const rejected = runtimePrdDocumentV2Schema.safeParse(document);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 marked 不涉及 contradicts a requested function, page, interface, or logic change",
        }),
      ]));
    }

    expect(runtimeResultSchema.safeParse({
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: document.title,
        operation: { kind: "create" },
        citations: document.citations,
        content: document,
      }],
    }).success).toBe(false);

    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "是",
      remarks: "本次建设订单状态通知设置页面及相关业务能力。",
    };
    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
    expect(runtimeResultSchema.safeParse({
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: document.title,
        operation: { kind: "create" },
        citations: document.citations,
        content: document,
      }],
    }).success).toBe(true);
  });

  it("allows safety row 1 to remain 不涉及 for explicit documentation-only scope", () => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "documentation-only-scope",
      type: "paragraph",
      content: text("本次仅梳理现有页面和功能，不建设、开发、实现、修改或改造任何功能、页面和逻辑。"),
    });

    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it.each([
    "本次不进行任何功能、页面或逻辑调整。",
    "功能、页面、接口及逻辑均保持不变。",
  ])("accepts common explicit global no-change wording for safety row 1: %s", (fact) => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "explicit-global-no-change",
      type: "paragraph",
      content: text(fact),
    });

    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it("does not let a global no-change clause mask a later explicit change", () => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "mixed-global-no-change",
      type: "paragraph",
      content: text("本次不进行任何功能、页面或逻辑调整，新增帮助页面。"),
    });

    const result = runtimePrdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 marked 不涉及 contradicts a requested function, page, interface, or logic change",
        }),
      ]));
    }
  });

  it.each([
    "本需求不新增任何功能。",
    "本需求不新增页面功能。",
  ])("does not treat a local no-addition constraint as global no-change evidence: %s", (fact) => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "local-no-addition-constraint",
      type: "paragraph",
      content: text(fact),
    });

    const result = runtimePrdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 marked 不涉及 requires an explicit statement that no function, page, interface, or logic change exists",
        }),
      ]));
    }
  });

  it("requires explicit global negative evidence before safety row 1 can be 不涉及", () => {
    const document = withoutSafetyEvidence();

    expect(prdDocumentV2Schema.safeParse(document).success).toBe(true);
    const result = runtimePrdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 marked 不涉及 requires an explicit statement that no function, page, interface, or logic change exists",
        }),
      ]));
    }
  });

  it("keeps row 1 negation scoped to its clause", () => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "mixed-functional-change-scope",
      type: "paragraph",
      content: text("本需求不新增接口，但调整现有页面逻辑。"),
    });

    const result = runtimePrdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 marked 不涉及 contradicts a requested function, page, interface, or logic change",
        }),
      ]));
    }

    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "是",
      remarks: "本次调整现有页面逻辑。",
    };
    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it.each([
    "现有功能由开发人员维护，本次仅梳理需求文档。",
    "订单状态变更会触发通知，本次仅梳理现有流程。",
  ])("does not treat current-state wording as row 1 change evidence: %s", (fact) => {
    const document = withoutSafetyEvidence();
    document.sections.introduction.background.blocks.push({
      id: "current-state-description",
      type: "paragraph",
      content: text(`${fact} 本需求不涉及功能逻辑变更。`),
    });

    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it("recognizes a newly added business control as row 1 change evidence", () => {
    const document = withoutSafetyEvidence();
    document.sections.businessRequirements.coreRules.blocks.push({
      id: "new-notification-control",
      type: "paragraph",
      content: text("新增通知开关。"),
    });

    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(false);
    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "是",
      remarks: "新增通知开关控件。",
    };
    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it.each([
    "新增订单状态。",
    "调整订单状态。",
  ])("recognizes an explicit order-state change as row 1 evidence: %s", (fact) => {
    const document = withoutSafetyEvidence();
    document.sections.businessRequirements.coreRules.blocks.push({
      id: "order-state-change",
      type: "paragraph",
      content: text(fact),
    });

    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(false);
    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "是",
      remarks: fact,
    };
    expect(runtimePrdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it("rejects 否 and vague remarks for safety row 1", () => {
    const document = withoutSafetyEvidence();
    document.sections.businessRequirements.coreRules.blocks.push({
      id: "row-one-remediation",
      type: "paragraph",
      content: text("本次建设通知设置页面，上线前需补充改造页面权限逻辑。"),
    });
    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "否",
      remarks: "上线前完成页面权限逻辑改造。",
    };

    const noResult = runtimePrdDocumentV2Schema.safeParse(document);
    expect(noResult.success).toBe(false);
    if (!noResult.success) {
      expect(noResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "applicability"],
          message: "safety row 1 must be 是 when a function, page, interface, or logic change exists; otherwise use 不涉及 with explicit negative evidence",
        }),
      ]));
    }

    document.sections.safetyBaseline.rows[0] = {
      sequence: 1,
      applicability: "是",
      remarks: "已完成安全自查。",
    };
    const vagueResult = runtimePrdDocumentV2Schema.safeParse(document);
    expect(vagueResult.success).toBe(false);
    if (!vagueResult.success) {
      expect(vagueResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 0, "remarks"],
          message: "safety row 1 marked 是 must name the concrete function, page, interface, or logic change",
        }),
      ]));
    }
  });

  it("accepts 不涉及 for all 21 safety rows when the body has negative or no evidence", () => {
    expect(negativeOrAbsentSafetyFacts).toHaveLength(21);

    for (const [index, fact] of negativeOrAbsentSafetyFacts.entries()) {
      const document = withoutSafetyEvidence();
      if (fact) {
        document.sections.businessRequirements.coreRules.blocks.push({
          id: `negative-safety-evidence-${index + 1}`,
          type: "paragraph",
          content: text(fact),
        });
      }
      const result = index === 0
        ? runtimePrdDocumentV2Schema.safeParse(document)
        : prdDocumentV2Schema.safeParse(document);
      expect(result.success, `safety row ${index + 1}`).toBe(true);
    }
  });

  it("does not confuse generic in-app channels or excluded app surfaces with row 12 evidence", () => {
    for (const [index, fact] of [
      "渠道范围：本次仅覆盖端内通知相关设置，不投放 WAP/H5 端外渠道和小程序。",
      "本需求选择端内渠道，APP 与小程序均不投放。",
      "客户端、消费者端和前端均沿用现有页面。",
      "mapping 页面入口保持不变。",
      "HAPPY 业务页面保持不变。",
      "DAPP 页面入口保持不变。",
      "APPS 业务页面保持不变。",
      "小程序不投放，但 APP 也未启用。",
      "APP 业务并未运行，小程序不再发布。",
      "本需求不涉及 APP 和小程序业务。",
      "不投放 APP/小程序页面。",
      "APP 业务并且未运行。",
      "APP、小程序均不投放。",
      "本需求不涉及 APP，小程序业务。",
    ].entries()) {
      const document = withoutSafetyEvidence();
      document.sections.businessRequirements.coreRules.blocks.push({
        id: `excluded-app-surface-${index + 1}`,
        type: "paragraph",
        content: text(fact),
      });
      expect(prdDocumentV2Schema.safeParse(document).success, fact).toBe(true);
    }

    const misclassified = withoutSafetyEvidence();
    misclassified.sections.businessRequirements.coreRules.blocks.push({
      id: "excluded-app-surface-misclassified",
      type: "paragraph",
      content: text("渠道范围：本次仅覆盖端内通知相关设置，不投放 WAP/H5 端外渠道和小程序。"),
    });
    misclassified.sections.safetyBaseline.rows[11]!.applicability = "是";
    misclassified.sections.safetyBaseline.rows[11]!.remarks = "端内渠道需要核查双清单。";
    expect(prdDocumentV2Schema.safeParse(misclassified).success).toBe(true);
    const misclassifiedResult = runtimePrdDocumentV2Schema.safeParse(misclassified);
    expect(misclassifiedResult.success).toBe(false);
    if (!misclassifiedResult.success) {
      expect(misclassifiedResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 11, "applicability"],
          message: "a safety row marked 是 or 否 requires affirmative semantic evidence in the requirement body",
        }),
      ]));
    }
    expect(runtimeResultSchema.safeParse({
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: misclassified.title,
        operation: { kind: "create" },
        citations: misclassified.citations,
        content: misclassified,
      }],
    }).success).toBe(false);

    const affirmative = withoutSafetyEvidence();
    affirmative.sections.businessRequirements.coreRules.blocks.push({
      id: "affirmative-app-surface",
      type: "paragraph",
      content: text("小程序不投放，但订单通知业务运行于 APP 并提供 APP 页面入口。"),
    });
    const affirmativeResult = prdDocumentV2Schema.safeParse(affirmative);
    expect(affirmativeResult.success).toBe(false);
    if (!affirmativeResult.success) {
      expect(affirmativeResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 11, "applicability"],
          message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
        }),
      ]));
    }

    for (const [index, fact] of [
      "APP 不投放且小程序业务正常运行。",
      "小程序不投放同时 APP 业务正常运行。",
      "旧 APP 不再运行，新 APP 正常运行并提供页面入口。",
      "业务运行于 app。",
      "端内 APP 页面入口启用。",
      "APP 正常运行。",
      "小程序已启用。",
      "APP 页面入口存在，小程序不涉及。",
      "APP 不涉及，小程序页面入口存在。",
      "小程序不在本次投放范围内但订单通知业务运行于 APP 并提供 APP 页面入口。",
      "订单通知业务运行于 APP 并提供 APP 页面入口但小程序不在本次投放范围内。",
    ].entries()) {
      const mixed = withoutSafetyEvidence();
      mixed.sections.businessRequirements.coreRules.blocks.push({
        id: `mixed-app-surface-${index + 1}`,
        type: "paragraph",
        content: text(fact),
      });
      const mixedResult = prdDocumentV2Schema.safeParse(mixed);
      expect(mixedResult.success, fact).toBe(false);
      if (!mixedResult.success) {
        expect(mixedResult.error.issues, fact).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: ["sections", "safetyBaseline", "rows", 11, "applicability"],
            message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
          }),
        ]));
      }
    }
  });

  it("treats app surfaces outside the delivery scope as negative row 12 evidence", () => {
    for (const surface of ["APP", "小程序"] as const) {
      for (const exclusion of ["不在", "不属于"] as const) {
        for (const action of ["投放", "发布", "运行", "启用", "加载"] as const) {
          const scope = exclusion === "不在" ? "范围内" : "范围";
          const fact = `WAP/H5 和${surface}${exclusion}本次${action}${scope}。`;
          const excluded = withoutSafetyEvidence();
          excluded.sections.businessRequirements.coreRules.blocks.push({
            id: "no-functional-change",
            type: "paragraph",
            content: text("本需求不涉及功能逻辑变更。"),
          });
          excluded.sections.degradation.content.push(...text(fact));
          excluded.sections.safetyBaseline.rows[11] = {
            sequence: 12,
            applicability: "不涉及",
            remarks: null,
          };
          expect(runtimePrdDocumentV2Schema.safeParse(excluded).success, fact).toBe(true);

          const misclassified = structuredClone(excluded);
          misclassified.sections.safetyBaseline.rows[11] = {
            sequence: 12,
            applicability: "是",
            remarks: "已检查 APP 与小程序双清单要求。",
          };
          const result = runtimePrdDocumentV2Schema.safeParse(misclassified);
          expect(result.success, fact).toBe(false);
          if (!result.success) {
            expect(result.error.issues, fact).toEqual([
              expect.objectContaining({
                path: ["sections", "safetyBaseline", "rows", 11, "applicability"],
                message: "a safety row marked 是 or 否 requires affirmative semantic evidence in the requirement body",
              }),
            ]);
          }
        }
      }
    }
  });

  it("keeps app surfaces outside the excluded scope as affirmative row 12 evidence", () => {
    for (const fact of [
      "APP 不在本次投放范围外。",
      "小程序不属于本次发布范围之外。",
      "APP 不在本次启用范围以外。",
    ]) {
      const document = withoutSafetyEvidence();
      document.sections.businessRequirements.coreRules.blocks.push({
        id: "no-functional-change",
        type: "paragraph",
        content: text("本需求不涉及功能逻辑变更。"),
      });
      document.sections.degradation.content.push(...text(fact));
      document.sections.safetyBaseline.rows[11] = {
        sequence: 12,
        applicability: "不涉及",
        remarks: null,
      };

      const result = runtimePrdDocumentV2Schema.safeParse(document);
      expect(result.success, fact).toBe(false);
      if (!result.success) {
        expect(result.error.issues, fact).toEqual([
          expect.objectContaining({
            path: ["sections", "safetyBaseline", "rows", 11, "applicability"],
            message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
          }),
        ]);
      }
    }
  });

  it("distinguishes public consumer access from an internal consumer-rights admin console", () => {
    for (const [index, fact] of [
      "已登录消费者可以进入订单通知页面并配置提醒。",
      "目标用户为已登录消费者。",
      "页面面向已登录的消费者。",
      "目标用户为已登录的消费者。",
      "本功能支持已登录消费者在端内配置通知。",
      "消费者使用通知设置功能。",
    ].entries()) {
      const consumerAccess = withoutSafetyEvidence();
      consumerAccess.sections.businessRequirements.coreRules.blocks.push({
        id: `consumer-access-evidence-${index + 1}`,
        type: "paragraph",
        content: text(fact),
      });
      const consumerResult = prdDocumentV2Schema.safeParse(consumerAccess);
      expect(consumerResult.success, fact).toBe(false);
      if (!consumerResult.success) {
        expect(consumerResult.error.issues, fact).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: ["sections", "safetyBaseline", "rows", 1, "applicability"],
            message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
          }),
        ]));
      }
    }

    for (const [index, fact] of [
      "消费者权益管理后台由内部客服人员操作。",
      "消费者将由内部客服统一管理。",
      "管理后台支持客服查看消费者订单。",
      "页面面向内部客服展示消费者订单。",
      "管理后台提供给内部客服查看消费者订单的能力。",
      "本功能不支持消费者使用。",
      "本功能不再支持消费者使用。",
      "页面不再面向消费者。",
      "页面尚未面向消费者。",
      "消费者可以由客服查看其订单。",
      "目标用户为内部客服，负责查看消费者订单。",
      "服务对象包括内部客服和消费者信息管理员。",
    ].entries()) {
      const internalAdmin = withoutSafetyEvidence();
      internalAdmin.sections.businessRequirements.coreRules.blocks.push({
        id: `consumer-internal-admin-${index + 1}`,
        type: "paragraph",
        content: text(fact),
      });
      expect(prdDocumentV2Schema.safeParse(internalAdmin).success, fact).toBe(true);
    }
  });

  it("keeps safety negation scoped to its own topic", () => {
    const document = withoutSafetyEvidence();
    document.sections.businessRequirements.coreRules.blocks.push({
      id: "mixed-topic-api-evidence",
      type: "paragraph",
      content: text("本需求不涉及本次活动投放渠道调整及全部营销相关能力，但新增 API 接口并完成台账填报。"),
    });

    const result = prdDocumentV2Schema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 16, "applicability"],
          message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
        }),
      ]));
    }
  });

  it("requires sensitive or cross-system API context for safety row 18", () => {
    const ordinaryAccessControl = withoutSafetyEvidence();
    ordinaryAccessControl.sections.businessRequirements.coreRules.blocks.push({
      id: "ordinary-access-control",
      type: "paragraph",
      content: text("管理后台按业务角色执行访问控制。"),
    });
    expect(prdDocumentV2Schema.safeParse(ordinaryAccessControl).success).toBe(true);

    const sensitiveApi = withoutSafetyEvidence();
    sensitiveApi.sections.businessRequirements.coreRules.blocks.push({
      id: "sensitive-api-access-control",
      type: "paragraph",
      content: text("跨系统 API 接口传输敏感信息，并采用接口鉴权、访问控制和加密传输。"),
    });
    const result = prdDocumentV2Schema.safeParse(sensitiveApi);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["sections", "safetyBaseline", "rows", 17, "applicability"],
          message: "a safety row marked 不涉及 contradicts affirmative semantic evidence in the requirement body",
        }),
      ]));
    }
  });

  it("requires distinct acceptance coverage instead of repeated generic rows", () => {
    const duplicated = cloneExample();
    for (const row of acceptanceTable(duplicated).rows) {
      row.cells[1]!.content = text("通用检查");
      row.cells[2]!.content = text("系统展示正确结果且符合预期要求。 ");
    }
    expect(prdDocumentV2Schema.safeParse(duplicated).success).toBe(false);

    const missingRecovery = cloneExample();
    const rows = acceptanceTable(missingRecovery).rows;
    rows[5]!.cells[1]!.content = text("状态反馈");
    rows[5]!.cells[2]!.content = text("系统持续展示当前状态与最终处理结果。 ");
    rows[6]!.cells[1]!.content = text("结果一致性");
    rows[6]!.cells[2]!.content = text("页面结果与任务记录保持一致。 ");
    expect(prdDocumentV2Schema.safeParse(missingRecovery).success).toBe(false);
  });

  it("requires only acceptance dimensions that are clearly relevant in the requirement body", () => {
    const compact = withoutEmptyOrFailureRequirements();
    expect(acceptanceTable(compact).rows).toHaveLength(4);
    expect(prdDocumentV2Schema.safeParse(compact).success).toBe(true);

    const missingRelevantPermission = withoutEmptyOrFailureRequirements();
    const permissionRow = acceptanceTable(missingRelevantPermission).rows.find((row) => row.id === "acceptance-permission");
    const item = permissionRow?.cells.find((cell) => cell.columnId === acceptanceTable(missingRelevantPermission).columns[1]?.id);
    if (!item) throw new Error("missing permission acceptance row");
    item.content = text("并发操作约束");
    const result = prdDocumentV2Schema.safeParse(missingRelevantPermission);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message === "acceptance criteria must cover 权限控制")).toBe(true);
    }

    const missingRelevantState = withoutEmptyOrFailureRequirements();
    const visibilityRow = acceptanceTable(missingRelevantState).rows.find((row) => row.id === "acceptance-visible");
    const visibilityItem = visibilityRow?.cells.find((cell) => cell.columnId === acceptanceTable(missingRelevantState).columns[1]?.id);
    if (!visibilityItem) throw new Error("missing visibility acceptance row");
    visibilityItem.content = text("页面与阶段可见性");
    const stateRow = acceptanceTable(missingRelevantState).rows.find((row) => row.id === "acceptance-state");
    const stateItem = stateRow?.cells.find((cell) => cell.columnId === acceptanceTable(missingRelevantState).columns[1]?.id);
    if (!stateItem) throw new Error("missing state acceptance row");
    stateItem.content = text("处理顺序约束");
    const stateResult = prdDocumentV2Schema.safeParse(missingRelevantState);
    expect(stateResult.success).toBe(false);
    if (!stateResult.success) {
      expect(stateResult.error.issues.some((issue) => issue.message === "acceptance criteria must cover 状态流转与结果")).toBe(true);
    }
  });

  it("does not infer permission or state acceptance from persona roles or generic completion results", () => {
    const document = withoutPermissionOrStateRequirements();
    document.sections.businessRequirements.coreRules.blocks.push({
      id: "persona-operator",
      type: "persona",
      name: "运营人员",
      description: text("目标使用角色为运营人员。"),
      needs: ["快速查看待办事项。"],
      painPoints: ["信息分散导致处理效率偏低。"],
    }, {
      id: "generic-completion-result",
      type: "paragraph",
      content: text("运营人员完成页面浏览后记录处理结果。"),
    });

    expect(prdDocumentV2Schema.safeParse(document).success).toBe(true);
  });

  it("rejects semantic duplicate channel tables and channel fact contradictions", () => {
    const semanticDuplicate = cloneExample();
    semanticDuplicate.sections.businessRequirements.coreRules.blocks.push({
      id: "secondary-channel-table",
      type: "table",
      columns: [
        { id: "secondary-channel", label: "渠道" },
        { id: "secondary-enabled", label: "是否启用" },
      ],
      rows: [{
        id: "secondary-channel-row",
        cells: [
          { columnId: "secondary-channel", content: text("端内渠道") },
          { columnId: "secondary-enabled", content: text("是") },
        ],
      }],
    });
    expect(prdDocumentV2Schema.safeParse(semanticDuplicate).success).toBe(false);

    const contradictory = cloneExample();
    contradictory.sections.introduction.usageScenarios.channelTable.rows[0]!.enabled = false;
    contradictory.sections.introduction.usageScenarios.channelTable.rows[1]!.enabled = true;
    expect(prdDocumentV2Schema.safeParse(contradictory).success).toBe(false);

    const negated = cloneExample();
    negated.sections.introduction.usageScenarios.blocks[0] = {
      id: "usage-main",
      type: "paragraph",
      content: text("用户从产品工作台端内入口发起任务，本需求不启用小程序。"),
    };
    negated.sections.introduction.usageScenarios.channelTable.rows[2]!.enabled = true;
    expect(prdDocumentV2Schema.safeParse(negated).success).toBe(false);

    const miniProgram = cloneExample();
    miniProgram.sections.introduction.usageScenarios.blocks[0] = {
      id: "usage-main",
      type: "paragraph",
      content: text("已登录用户从微信小程序入口发起任务并确认结果。"),
    };
    miniProgram.sections.introduction.usageScenarios.channelTable.rows[0]!.enabled = false;
    miniProgram.sections.introduction.usageScenarios.channelTable.rows[2]!.enabled = true;
    miniProgram.sections.safetyBaseline.rows[11] = {
      sequence: 12,
      applicability: "是",
      remarks: "小程序业务已按正文完成安全自查。",
    };
    expect(prdDocumentV2Schema.safeParse(miniProgram).success).toBe(true);
  });

  it("rejects template reminders, standalone weak wording, and standalone API chapters", () => {
    const reminder = cloneExample();
    reminder.sections.introduction.background.blocks[0] = {
      id: "background-main",
      type: "paragraph",
      content: [{ type: "text", text: "最后记得更新业务说明。", marks: [] }],
    };
    expect(prdDocumentV2Schema.safeParse(reminder).success).toBe(false);

    const weak = cloneExample();
    weak.sections.introduction.background.blocks[0] = {
      id: "background-main",
      type: "paragraph",
      content: [{ type: "text", text: "与旧页面逻辑相同", marks: [] }],
    };
    expect(prdDocumentV2Schema.safeParse(weak).success).toBe(false);

    const apiHeading = cloneExample();
    apiHeading.sections.businessRequirements.coreRules.blocks.push({
      id: "api-heading",
      type: "heading",
      level: 2,
      content: [{ type: "text", text: "API 清单", marks: [] }],
    });
    expect(prdDocumentV2Schema.safeParse(apiHeading).success).toBe(false);

    const numberedApiHeading = cloneExample();
    numberedApiHeading.sections.businessRequirements.coreRules.blocks.push({
      id: "numbered-api-heading",
      type: "heading",
      level: 2,
      content: text("2.5 新增接口"),
    });
    expect(prdDocumentV2Schema.safeParse(numberedApiHeading).success).toBe(false);

    const englishPlaceholder = cloneExample();
    englishPlaceholder.sections.introduction.background.blocks[0] = {
      id: "background-main",
      type: "paragraph",
      content: text("TBD"),
    };
    expect(prdDocumentV2Schema.safeParse(englishPlaceholder).success).toBe(false);

    const chinesePlaceholder = cloneExample();
    chinesePlaceholder.sections.introduction.background.blocks[0] = {
      id: "background-main",
      type: "paragraph",
      content: text("页面规则待补充。"),
    };
    expect(prdDocumentV2Schema.safeParse(chinesePlaceholder).success).toBe(false);
  });

  it("binds PRD protocol v2 to Artifact schemaVersion 2", () => {
    const candidate = {
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: prdDocumentV2Example.title,
        operation: { kind: "create" },
        citations: [],
        content: prdDocumentV2Example,
      }],
    };

    expect(runtimeResultSchema.safeParse(candidate).success).toBe(true);
    expect(runtimeResultSchema.safeParse({
      ...candidate,
      artifacts: [{ ...candidate.artifacts[0], schemaVersion: 1 }],
    }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({
      ...candidate,
      artifacts: [{ ...candidate.artifacts[0], title: "完全不同的产物标题" }],
    }).success).toBe(false);
  });

  it("publishes PRD protocol, schemaVersion, and create constraints in the deployed JSON Schema", () => {
    const v2Create = {
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已生成。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 2,
        title: prdDocumentV2Example.title,
        operation: { kind: "create" },
        citations: [],
        content: prdDocumentV2Example,
      }],
    };
    const v1Revise = {
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已更新。",
      artifacts: [{
        kind: "prd",
        schemaVersion: 1,
        title: "Legacy PRD",
        operation: {
          kind: "revise",
          target: {
            artifactId: "artifact-legacy-prd",
            artifactVersionId: "version-legacy-prd",
            screenIds: [],
          },
        },
        citations: [],
        content: legacyPrdDocument(),
      }],
    };

    expect(deployedRuntimeResultValidator.validate(v2Create).valid).toBe(true);
    expect(deployedRuntimeResultValidator.validate({
      ...v2Create,
      artifacts: [{ ...v2Create.artifacts[0], schemaVersion: 1 }],
    }).valid).toBe(false);
    expect(deployedRuntimeResultValidator.validate(v1Revise).valid).toBe(true);
    expect(deployedRuntimeResultValidator.validate({
      ...v1Revise,
      artifacts: [{ ...v1Revise.artifacts[0], operation: { kind: "create" } }],
    }).valid).toBe(false);
  });

  it("keeps Artifact API v1 compatibility while pairing v2 content with schemaVersion 2", () => {
    const detail = {
      artifactId: "artifact-prd-v2",
      artifactVersionId: "artifact-version-prd-v2",
      version: 1,
      status: "staging",
      checksum: "a".repeat(64),
      citations: [],
      createdByRunId: "run-prd-v2",
      knowledgeReleaseId: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      contentMode: "inline",
      kind: "prd",
      schemaVersion: 2,
      content: prdDocumentV2Example,
    };

    expect(artifactVersionInlineDetailSchema.safeParse(detail).success).toBe(true);
    expect(artifactVersionInlineDetailSchema.safeParse({
      ...detail,
      schemaVersion: 1,
    }).success).toBe(false);
    expect(createArtifactVersionRequestSchema.safeParse({
      baseArtifactVersionId: "artifact-version-prd-v2",
      kind: "prd",
      document: prdDocumentV2Example,
    }).success).toBe(true);
    expect(createArtifactVersionRequestSchema.safeParse({
      baseArtifactVersionId: "artifact-version-prd-v1",
      kind: "prd",
      document: legacyPrdDocument(),
    }).success).toBe(true);
  });

  it("requires v2 for new PRDs while keeping existing v1 Artifacts revision-compatible", () => {
    const artifact = {
      kind: "prd",
      schemaVersion: 1,
      title: "Legacy PRD",
      citations: [],
      content: legacyPrdDocument(),
    };
    const candidate = {
      protocol: "workbench.runtime.result.v1",
      message: "需求说明书已更新。",
      artifacts: [{ ...artifact, operation: { kind: "create" } }],
    };

    expect(runtimeResultSchema.safeParse(candidate).success).toBe(false);
    expect(runtimeResultSchema.safeParse({
      ...candidate,
      artifacts: [{
        ...artifact,
        operation: {
          kind: "revise",
          target: {
            artifactId: "artifact-legacy-prd",
            artifactVersionId: "version-legacy-prd",
            screenIds: [],
          },
        },
      }],
    }).success).toBe(true);
  });
});

function legacyPrdDocument() {
  const text = (value: string) => [{ type: "text" as const, text: value, marks: [] }];
  return {
    protocol: "workbench.prd.v1" as const,
    documentId: "legacy-prd",
    title: "Legacy PRD",
    revision: {
      number: 1,
      status: "draft" as const,
      summary: "Initial revision",
      changedAt: "2026-07-23T00:00:00.000Z",
      changedById: null,
    },
    assumptions: [],
    citations: [],
    sections: {
      executiveSummary: {
        title: "Executive summary",
        blocks: [{ id: "legacy-summary", type: "paragraph" as const, content: text("Summary") }],
      },
      problem: {
        title: "Problem",
        blocks: [{ id: "legacy-problem", type: "paragraph" as const, content: text("Problem") }],
      },
      goals: {
        title: "Goals",
        blocks: [{
          id: "legacy-goal",
          type: "goal" as const,
          title: "Goal",
          description: text("Goal description"),
          successMetric: "Metric",
          priority: "primary" as const,
        }],
      },
      targetUsers: {
        title: "Target users",
        blocks: [{
          id: "legacy-persona",
          type: "persona" as const,
          name: "User",
          description: text("User description"),
          needs: ["Need"],
          painPoints: ["Pain point"],
        }],
      },
      scope: {
        title: "Scope",
        blocks: [{
          id: "legacy-scope",
          type: "bulletList" as const,
          items: [{ id: "legacy-scope-item", content: text("Scope item") }],
        }],
      },
      requirements: {
        title: "Requirements",
        blocks: [{
          id: "legacy-requirement",
          type: "requirement" as const,
          title: "Requirement",
          description: text("Requirement description"),
          priority: "must" as const,
          goalIds: ["legacy-goal"],
          acceptanceCriterionIds: ["legacy-criterion"],
        }],
      },
      userFlows: {
        title: "User flows",
        blocks: [{
          id: "legacy-flow",
          type: "flow" as const,
          title: "Flow",
          actor: "User",
          trigger: "Start",
          steps: [{ id: "legacy-step", text: "Complete action", requirementIds: ["legacy-requirement"] }],
          outcome: "Done",
        }],
      },
      acceptanceCriteria: {
        title: "Acceptance criteria",
        blocks: [{
          id: "legacy-criterion",
          type: "acceptanceCriterion" as const,
          requirementIds: ["legacy-requirement"],
          given: text("Given"),
          when: text("When"),
          then: text("Then"),
        }],
      },
      risksAndDependencies: {
        title: "Risks and dependencies",
        blocks: [{
          id: "legacy-risk",
          type: "risk" as const,
          description: text("Risk"),
          likelihood: "low" as const,
          impact: "low" as const,
          mitigation: text("Mitigation"),
        }],
      },
    },
  };
}

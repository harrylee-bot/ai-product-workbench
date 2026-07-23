import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import {
  artifactVersionInlineDetailSchema,
  createArtifactVersionRequestSchema,
  prdDocumentSchema,
  prdDocumentV2Example,
  prdDocumentV2Schema,
  runtimeResultSchema,
} from "../src/index.js";

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

  it("defines affirmative semantic evidence for all 21 safety rows", () => {
    const facts = [
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
    ];
    expect(facts).toHaveLength(21);

    for (const [index, fact] of facts.entries()) {
      const document = cloneExample();
      for (const row of document.sections.safetyBaseline.rows) {
        row.applicability = "不涉及";
        row.remarks = null;
      }
      document.sections.businessRequirements.coreRules.blocks.push({
        id: `safety-evidence-${index + 1}`,
        type: "paragraph",
        content: text(fact!),
      });
      document.sections.safetyBaseline.rows[index] = {
        sequence: index + 1,
        applicability: "是",
        remarks: `第 ${index + 1} 项已根据正文事实完成自查。`,
      };
      expect(prdDocumentV2Schema.safeParse(document).success, `safety row ${index + 1}`).toBe(true);
    }
  });

  it("does not treat explicit safety exclusions as affirmative evidence", () => {
    const exclusions = [
      [1, "本需求不涉及功能逻辑变更。"],
      [12, "本需求不启用小程序。"],
      [13, "本需求不采集身份证、银行卡或生物识别信息。"],
      [14, "本需求不启用一键登录。"],
      [15, "本需求不跳转第三方页面或应用。"],
      [16, "本需求不与第三方公司进行接口对接。"],
      [17, "本需求不新增 API 接口。"],
      [18, "本需求不涉及敏感信息或跨系统调用。"],
      [19, "本需求不存储用户信息或重要数据。"],
      [20, "本需求不采集用户数据。"],
      [21, "本需求无需校验数据完整性与一致性。"],
    ] as const;

    for (const [sequence, fact] of exclusions) {
      const document = cloneExample();
      document.sections.businessRequirements.coreRules.blocks = document.sections.businessRequirements.coreRules.blocks
        .filter((block) => block.id !== "safety-facts");
      if (sequence === 1) {
        document.sections.introduction.background.blocks[0] = {
          id: "background-main",
          type: "paragraph",
          content: text("现有产品工作台提供业务任务入口，用户可提交任务并查看处理结果。"),
        };
      }
      for (const row of document.sections.safetyBaseline.rows) {
        row.applicability = "不涉及";
        row.remarks = null;
      }
      document.sections.businessRequirements.coreRules.blocks.push({
        id: `negative-safety-evidence-${sequence}`,
        type: "paragraph",
        content: text(fact),
      });
      document.sections.safetyBaseline.rows[sequence - 1] = {
        sequence,
        applicability: "是",
        remarks: "不得使用否定事实支持涉及结论。",
      };
      expect(prdDocumentV2Schema.safeParse(document).success, `safety row ${sequence}`).toBe(false);
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

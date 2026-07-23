import {
  prdDocumentV2Schema,
  prdSafetyBaselineItems,
  prdTableOfContentsEntries,
} from "./prd.js";

const text = (value: string) => [{ type: "text" as const, text: value, marks: [] }];

export const prdDocumentV2Example = prdDocumentV2Schema.parse({
  protocol: "workbench.prd.v2",
  documentId: "prd-example",
  title: "示例工单需求说明书",
  revision: {
    number: 1,
    status: "draft",
    summary: "初始版本",
    changedAt: "2026-07-23T00:00:00.000Z",
    changedById: null,
  },
  cover: {
    workOrderName: "示例工单",
    title: "示例工单需求说明书",
  },
  versionHistory: [{
    status: "讨论稿",
    author: "需求方",
    participants: ["业务评审人", "研发评审人", "测试评审人"],
    startDate: "2026-07-23",
    endDate: "2026-07-23",
    notes: "形成首版需求说明书并进入评审。",
  }],
  tableOfContents: {
    title: "目 录",
    entries: [...prdTableOfContentsEntries],
  },
  assumptions: [{
    id: "assumption-permission",
    statement: "默认目标业务用户已通过现有账号体系完成登录并具备进入功能页面的基础权限。",
    status: "open",
    impact: "medium",
    owner: "业务负责人",
    introducedInRevision: 1,
    citationIds: [],
  }],
  citations: [],
  sections: {
    introduction: {
      title: "1 引言",
      background: {
        title: "1.1项目背景",
        blocks: [{
          id: "background-main",
          type: "paragraph",
          content: text("现有产品工作台已提供业务任务处理入口，但处理状态、异常恢复和结果确认信息不完整，用户难以判断任务是否闭环。本需求调整工作台任务页面及配套处理能力，使用户能够提交必要信息、跟踪处理状态并确认最终结果。"),
        }],
      },
      scope: {
        title: "1.2文档范围",
        blocks: [{
          id: "scope-main",
          type: "bulletList",
          items: [
            { id: "scope-entry", content: text("工作台任务页面的入口、表单和结果区域。") },
            { id: "scope-state", content: text("任务状态、异常提示、重试和权限反馈规则。") },
            { id: "scope-quality", content: text("验收标准、业务降级方案和需求安全基线。") },
          ],
        }],
      },
      usageScenarios: {
        title: "1.3使用场景（必填）",
        blocks: [{
          id: "usage-main",
          type: "paragraph",
          content: text("已登录的目标业务用户从产品工作台端内入口发起任务，查看实时状态，并在成功或可恢复失败后完成结果确认。"),
        }],
        channelTable: {
          title: "活动投放渠道",
          rows: [
            { sequence: 1, channel: "inApp", enabled: true },
            { sequence: 2, channel: "wapH5", enabled: false },
            { sequence: 3, channel: "miniProgram", enabled: false },
          ],
        },
      },
    },
    businessRequirements: {
      title: "2 业务需求",
      summary: text("总体目标：让目标业务用户从端内入口完成任务提交、状态跟踪、异常恢复和结果确认的完整闭环。"),
      pageLinks: {
        title: "2.1页面链接",
        blocks: [{
          id: "page-links-main",
          type: "bulletList",
          items: [
            { id: "page-entry", content: text("页面入口：产品工作台 > 当前项目 > 任务页面。") },
            { id: "page-result", content: text("目标区域：任务页面中的提交区、运行状态区和结果区。") },
          ],
        }],
      },
      coreRules: {
        title: "2.2 核心业务规则/功能说明",
        blocks: [
          {
            id: "goal-main",
            type: "goal",
            title: "完成任务处理闭环",
            description: text("用户完成一次合法提交后，系统给出连续状态反馈，并最终展示成功结果或明确的可恢复失败。"),
            successMetric: "核心流程、权限、空状态和异常恢复验收用例全部通过",
            priority: "primary",
          },
          {
            id: "requirement-main",
            type: "requirement",
            title: "提交并跟踪任务",
            description: text("系统校验必填信息与用户权限，合法时创建任务并展示处理状态；失败时保留输入，说明原因并提供可执行的恢复操作。"),
            priority: "must",
            goalIds: ["goal-main"],
            acceptanceCriterionIds: ["criterion-main"],
          },
          {
            id: "safety-facts",
            type: "paragraph",
            content: text("本需求涉及现有任务处理功能逻辑变更；提交信息与任务状态均执行完整性和一致性校验。"),
          },
          {
            id: "rules-table",
            type: "table",
            columns: [
              { id: "feature", label: "功能点" },
              { id: "rule", label: "业务规则" },
              { id: "page", label: "页面要求" },
            ],
            rows: [{
              id: "rules-submit",
              cells: [
                { columnId: "feature", content: text("任务提交") },
                { columnId: "rule", content: text("必填信息完整且用户具备权限时才允许提交，同一请求不得重复创建任务。") },
                { columnId: "page", content: text("提交期间禁用重复操作，并持续展示当前阶段；失败时保留输入。") },
              ],
            }],
          },
        ],
      },
      flowAndPages: {
        title: "2.3 核心流程/状态/页面要求",
        blocks: [
          {
            id: "flow-main",
            type: "flow",
            title: "核心业务流程",
            actor: "目标业务用户",
            trigger: "用户进入任务页面并提交完整信息",
            steps: [
              { id: "flow-input", text: "用户填写必要信息并发起提交。", requirementIds: ["requirement-main"] },
              { id: "flow-validate", text: "系统校验输入与权限，合法时创建任务，不合法时返回明确原因。", requirementIds: ["requirement-main"] },
              { id: "flow-handle", text: "系统持续展示处理阶段，并在结束后显示成功结果或可恢复失败。", requirementIds: ["requirement-main"] },
              { id: "flow-confirm", text: "用户确认结果；失败时按页面操作重试，无权限时退出当前流程。", requirementIds: ["requirement-main"] },
            ],
            outcome: "用户获得可确认、可追踪且可恢复的任务处理结果。",
          },
          {
            id: "diagram-explanation",
            type: "paragraph",
            content: text("产品流程图对应用户从进入页面到确认结果的操作与异常分支；产品架构图对应页面、任务能力、业务规则、状态记录、异常治理和验收反馈之间的产品关系。"),
          },
        ],
        diagrams: [
          {
            id: "product-flow",
            kind: "productFlow",
            title: "图1 产品流程图",
            description: "覆盖进入页面、提交校验、任务处理、成功确认以及校验失败后的修正重试路径。",
            nodes: [
              { id: "flow-node-entry", label: "进入任务页面", group: "用户操作" },
              { id: "flow-node-submit", label: "填写并提交", group: "用户操作" },
              { id: "flow-node-validate", label: "校验信息与权限", group: "业务规则" },
              { id: "flow-node-process", label: "处理并更新状态", group: "任务能力" },
              { id: "flow-node-result", label: "展示并确认结果", group: "用户反馈" },
              { id: "flow-node-retry", label: "修正信息后重试", group: "异常恢复" },
            ],
            edges: [
              { id: "flow-edge-entry-submit", from: "flow-node-entry", to: "flow-node-submit", label: null },
              { id: "flow-edge-submit-validate", from: "flow-node-submit", to: "flow-node-validate", label: null },
              { id: "flow-edge-validate-process", from: "flow-node-validate", to: "flow-node-process", label: "校验通过" },
              { id: "flow-edge-process-result", from: "flow-node-process", to: "flow-node-result", label: "处理完成" },
              { id: "flow-edge-validate-retry", from: "flow-node-validate", to: "flow-node-retry", label: "校验失败" },
              { id: "flow-edge-retry-submit", from: "flow-node-retry", to: "flow-node-submit", label: "重新提交" },
            ],
          },
          {
            id: "product-architecture",
            kind: "productArchitecture",
            title: "图2 产品架构图",
            description: "说明任务页面如何通过任务能力执行规则、记录状态、处理异常，并将可验收结果反馈给用户。",
            nodes: [
              { id: "arch-node-page", label: "任务页面", group: "页面" },
              { id: "arch-node-capability", label: "任务处理能力", group: "能力" },
              { id: "arch-node-rules", label: "输入与权限规则", group: "规则" },
              { id: "arch-node-state", label: "任务状态记录", group: "状态" },
              { id: "arch-node-exception", label: "异常与降级治理", group: "治理" },
              { id: "arch-node-acceptance", label: "结果与验收反馈", group: "反馈" },
            ],
            edges: [
              { id: "arch-edge-page-capability", from: "arch-node-page", to: "arch-node-capability", label: "发起任务" },
              { id: "arch-edge-rules-capability", from: "arch-node-rules", to: "arch-node-capability", label: "约束执行" },
              { id: "arch-edge-capability-state", from: "arch-node-capability", to: "arch-node-state", label: "记录阶段" },
              { id: "arch-edge-state-page", from: "arch-node-state", to: "arch-node-page", label: "展示状态" },
              { id: "arch-edge-capability-exception", from: "arch-node-capability", to: "arch-node-exception", label: "处理失败" },
              { id: "arch-edge-state-acceptance", from: "arch-node-state", to: "arch-node-acceptance", label: "形成结果" },
            ],
          },
        ],
      },
      acceptanceCriteria: {
        title: "2.4 验收标准",
        blocks: [
          {
            id: "criterion-main",
            type: "acceptanceCriterion",
            requirementIds: ["requirement-main"],
            given: text("用户已登录、具备任务权限并进入任务页面"),
            when: text("用户填写合法信息并提交任务"),
            then: text("系统只创建一次任务，连续展示处理状态，并最终显示可确认的成功结果"),
          },
          {
            id: "acceptance-table",
            type: "table",
            columns: [
              { id: "sequence", label: "序号" },
              { id: "item", label: "验收项" },
              { id: "standard", label: "验收标准" },
            ],
            rows: [
              {
                id: "acceptance-visible",
                cells: [
                  { columnId: "sequence", content: text("1") },
                  { columnId: "item", content: text("页面与状态可见性") },
                  { columnId: "standard", content: text("有权限用户可进入页面；提交后阶段按真实处理顺序更新，完成后结果区域可见。") },
                ],
              },
              {
                id: "acceptance-errors",
                cells: [
                  { columnId: "sequence", content: text("2") },
                  { columnId: "item", content: text("输入与业务规则") },
                  { columnId: "standard", content: text("缺少必填信息或输入不合法时禁止提交，保留已填内容，并在对应字段展示可执行的修正说明。") },
                ],
              },
              {
                id: "acceptance-permission",
                cells: [
                  { columnId: "sequence", content: text("3") },
                  { columnId: "item", content: text("权限与重复操作") },
                  { columnId: "standard", content: text("无任务权限的用户不可创建任务；合法请求在处理中禁用重复提交，同一请求只形成一条任务记录。") },
                ],
              },
              {
                id: "acceptance-state",
                cells: [
                  { columnId: "sequence", content: text("4") },
                  { columnId: "item", content: text("状态流转与结果") },
                  { columnId: "standard", content: text("任务阶段按实际处理顺序连续更新，成功后展示可确认结果，未完成前不得提前显示成功状态。") },
                ],
              },
              {
                id: "acceptance-empty",
                cells: [
                  { columnId: "sequence", content: text("5") },
                  { columnId: "item", content: text("空状态") },
                  { columnId: "standard", content: text("用户尚未提交任务时，结果区域显示明确空状态，不展示历史用户数据，并保留可用的提交入口。") },
                ],
              },
              {
                id: "acceptance-retry",
                cells: [
                  { columnId: "sequence", content: text("6") },
                  { columnId: "item", content: text("失败与重试") },
                  { columnId: "standard", content: text("依赖失败时展示失败原因和影响范围，保留用户输入，并仅在具备恢复条件时提供重试操作。") },
                ],
              },
              {
                id: "acceptance-recovery",
                cells: [
                  { columnId: "sequence", content: text("7") },
                  { columnId: "item", content: text("恢复与一致性") },
                  { columnId: "standard", content: text("服务恢复后可从原任务继续查询或安全重试，最终页面状态与任务记录一致，且不会生成重复结果。") },
                ],
              },
            ],
          },
        ],
      },
      additionalSections: [],
    },
    degradation: {
      title: "3 业务降级方案（必填）",
      applicable: true,
      content: text("任务处理依赖暂时不可用时，页面保留用户已填写的信息并停止重复提交，明确显示失败原因、影响范围和可重试入口；状态同步延迟时继续展示最后一次可信状态及更新时间，不提前宣告成功；权限校验不可用时按无权限处理且不创建任务；结果读取失败时保留任务编号并允许用户稍后刷新。系统恢复后，用户可从原任务继续查询或重新提交，重复请求必须复用既有结果，同时记录异常、恢复时间和最终处理状态，便于业务、研发和测试共同核对。"),
    },
    safetyBaseline: {
      title: "4 需求安全基线要求（必填）",
      intro: "该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：\n1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据\n2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；\n3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。\n建议：该表格请业务人员和开发人员共同参与自查并填写。",
      rows: prdSafetyBaselineItems.map(({ sequence }) => ({
        sequence,
        applicability: sequence === 1 || sequence === 21 ? "是" : "不涉及",
        remarks: sequence === 1
          ? "任务处理逻辑发生变动。"
          : sequence === 21
              ? "提交信息与任务状态需要完整性和一致性校验。"
              : null,
      })),
    },
  },
});

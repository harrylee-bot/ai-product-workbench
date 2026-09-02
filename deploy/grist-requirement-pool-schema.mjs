const choice = (label, choices, choiceOptions = undefined) => ({
  id: label.id,
  fields: {
    label: label.name,
    type: label.type ?? "Choice",
    widgetOptions: JSON.stringify({ choices, ...(choiceOptions ? { choiceOptions } : {}) }),
  },
});

export const requirementPoolTable = {
  id: "Requirements",
  columns: [
    {
      id: "RequirementId",
      fields: {
        label: "需求编号",
        type: "Text",
        isFormula: true,
        formula: '"REQ-%04d" % $id',
      },
    },
    { id: "Title", fields: { label: "需求标题", type: "Text" } },
    {
      id: "Description",
      fields: { label: "需求描述", type: "Text", widgetOptions: JSON.stringify({ wrap: true }) },
    },
    choice(
      { id: "Type", name: "需求类型" },
      ["新功能", "体验优化", "缺陷修复", "技术需求", "运营需求"],
    ),
    choice(
      { id: "Status", name: "状态" },
      ["待收集", "待评审", "已排期", "进行中", "已完成", "已关闭"],
      {
        "待收集": { fillColor: "#E8EAED", textColor: "#3C4043" },
        "待评审": { fillColor: "#FCE8B2", textColor: "#5F4300" },
        "已排期": { fillColor: "#D2E3FC", textColor: "#174EA6" },
        "进行中": { fillColor: "#D7AEFB", textColor: "#5B218E" },
        "已完成": { fillColor: "#CEEAD6", textColor: "#137333" },
        "已关闭": { fillColor: "#FAD2CF", textColor: "#A50E0E" },
      },
    ),
    choice(
      { id: "Priority", name: "优先级" },
      ["P0", "P1", "P2", "P3"],
      {
        P0: { fillColor: "#FAD2CF", textColor: "#A50E0E" },
        P1: { fillColor: "#FCE8B2", textColor: "#5F4300" },
        P2: { fillColor: "#D2E3FC", textColor: "#174EA6" },
        P3: { fillColor: "#E8EAED", textColor: "#3C4043" },
      },
    ),
    { id: "Product", fields: { label: "所属产品", type: "Text" } },
    { id: "Requester", fields: { label: "提出人", type: "Text" } },
    { id: "Owner", fields: { label: "负责人", type: "Text" } },
    { id: "TargetRelease", fields: { label: "目标版本", type: "Text" } },
    { id: "ExpectedDate", fields: { label: "期望日期", type: "Date" } },
    { id: "Estimate", fields: { label: "预估工作量", type: "Numeric" } },
    { id: "BusinessValue", fields: { label: "业务价值", type: "Numeric" } },
    { id: "Urgency", fields: { label: "紧急程度", type: "Numeric" } },
    { id: "Source", fields: { label: "需求来源", type: "Text" } },
    { id: "Customer", fields: { label: "客户/业务方", type: "Text" } },
    choice({ id: "Tags", name: "标签", type: "ChoiceList" }, []),
    { id: "ExternalLink", fields: { label: "关联链接", type: "Text" } },
    {
      id: "Notes",
      fields: { label: "备注", type: "Text", widgetOptions: JSON.stringify({ wrap: true }) },
    },
  ],
};

export const requirementPoolWorkspaceName = "需求管理";
export const requirementPoolDocumentName = "需求池";
export const requirementPoolLegacyDocumentNames = ["需求池 / Requirement Pool"];
export const requirementPoolViewName = "需求列表";

export type WorkbenchHomeTemplate = Readonly<{
  accent: string;
  id: string;
  kind: "marketplace" | "packing" | "profile";
  prompt: string;
  subtitle: string;
  targetSurface: "app" | "web";
  title: string;
}>;

export const workbenchHomeTemplates = [
  {
    accent: "#d7edf7",
    id: "local-service-marketplace",
    kind: "marketplace",
    prompt: "设计一款本地生活服务预约移动应用原型，包含服务发现、商家筛选、可用时段、订单确认、改期取消和评价流程。",
    subtitle: "本地生活 · 移动应用",
    targetSurface: "app",
    title: "服务预约市场",
  },
  {
    accent: "#0a0b10",
    id: "smart-trip-packing",
    kind: "packing",
    prompt: "设计一款智能旅行打包移动应用原型，根据目的地、天气和行程生成清单，支持同行者协作、物品提醒和离线查看。",
    subtitle: "旅行工具 · 移动应用",
    targetSurface: "app",
    title: "智能旅行打包",
  },
  {
    accent: "#d8d2c5",
    id: "creator-portfolio",
    kind: "profile",
    prompt: "设计一个创作者个人作品集 Web 原型，突出代表作品、项目案例、服务范围、客户评价和联系转化，并适配移动端浏览。",
    subtitle: "个人品牌 · Web",
    targetSurface: "web",
    title: "创作者作品集",
  },
  {
    accent: "#f4f2ee",
    id: "fitness-coach-booking",
    kind: "profile",
    prompt: "设计一个健身教练预约 Web 原型，包含教练档案、课程日历、训练计划、套餐购买、学员进度和续课提醒。",
    subtitle: "健康服务 · Web",
    targetSurface: "web",
    title: "健身教练预约",
  },
  {
    accent: "#bfd7e3",
    id: "community-resale",
    kind: "marketplace",
    prompt: "设计一款社区二手交易移动应用原型，包含附近商品、分类筛选、议价聊天、当面交付、安全提示和信用评价。",
    subtitle: "社区交易 · 移动应用",
    targetSurface: "app",
    title: "社区二手交易",
  },
  {
    accent: "#efe9dc",
    id: "jobseeker-profile",
    kind: "profile",
    prompt: "设计一个求职者职业档案 Web 原型，呈现工作经历、技能证据、项目成果和推荐信，并提供岗位匹配与联系入口。",
    subtitle: "职业档案 · Web",
    targetSurface: "web",
    title: "求职者职业档案",
  },
  {
    accent: "#d7edf7",
    id: "subscription-operations",
    kind: "marketplace",
    prompt: "设计一个订阅业务运营后台 Web 原型，包含收入与留存指标、套餐管理、用户分群、流失预警、优惠活动和客服工单。",
    subtitle: "业务运营 · Web",
    targetSurface: "web",
    title: "订阅业务运营台",
  },
  {
    accent: "#0a0b10",
    id: "order-fulfillment",
    kind: "packing",
    prompt: "设计一个电商订单履约看板 Web 原型，覆盖待拣货、打包、发货、异常订单、库存预警和承运商时效对比。",
    subtitle: "订单履约 · Web",
    targetSurface: "web",
    title: "订单履约看板",
  },
] as const satisfies readonly WorkbenchHomeTemplate[];

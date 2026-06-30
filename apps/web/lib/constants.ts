export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT
);

export const guestRegex = /^guest-\d+$/;

export const suggestions = [
  "帮我写一个签到打卡活动的 PRD",
  "把这个 PRD 补充验收标准和风控规则",
  "根据 PRD 生成一个可演示的原型",
  "总结当前方案的核心用户流程",
];

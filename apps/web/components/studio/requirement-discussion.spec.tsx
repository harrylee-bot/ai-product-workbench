// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RequirementDiscussionView } from "@/lib/studio/requirements-view";
import { RequirementDiscussion } from "./requirement-discussion";

const ready = (): RequirementDiscussionView => ({
  scopeKey: "user/project/thread/revision-one",
  status: "ready",
  contextLabel: "修改固定版本 2 · 活动详情 · 元素：领取按钮",
  messages: [],
  questions: [],
  evidence: [
    {
      id: "evidence-one",
      title: "活动配置手册",
      location: "规则配置 / 领取限制",
      quote: "当前模板支持参与次数限制。",
      release: "workbench-1.0.0",
      version: 3,
      scope: "template",
    },
  ],
  knowledgeStatus: "available",
  canConfirm: true,
  reviewCurrent: true,
  confirmationPending: false,
  hasEarlierMessages: false,
  review: {
    id: "summary-one",
    version: 2,
    goal: "在原活动中增加领取次数规则",
    platform: "活动平台",
    modules: ["规则配置"],
    roles: ["策划人员"],
    existing: [
      {
        id: "existing",
        text: "已支持参与次数配置",
        origin: "knowledge",
        evidenceIds: ["evidence-one"],
      },
    ],
    reuse: [
      {
        id: "reuse",
        text: "沿用现有活动配置入口",
        origin: "knowledge",
        evidenceIds: ["evidence-one"],
      },
    ],
    changes: [
      {
        id: "change",
        text: "增加每人领取次数",
        origin: "user",
        evidenceIds: [],
      },
    ],
    assumptions: [
      {
        id: "assumption",
        text: "字段放在现有规则区",
        origin: "suggestion",
        evidenceIds: ["evidence-one"],
      },
    ],
    platformChanges: [],
    pages: ["活动规则页"],
    flows: ["配置 → 领取"],
    preserved: ["原导航及登录流程"],
    target: "Web",
    design: ["沿用当前字段分组"],
    outputKinds: ["prd", "prototype"],
  },
});
function show(view = ready(), extras = {}) {
  const props = {
    view,
    canEdit: true,
    dirtyInput: false,
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onContinue: vi.fn(),
    onRecoverConfirmation: vi.fn().mockResolvedValue(undefined),
    onLoadEarlier: vi.fn().mockResolvedValue(undefined),
    ...extras,
  };
  const result = render(<RequirementDiscussion {...props} />);
  return {
    ...result,
    props,
    update: (changes: Partial<typeof props>) =>
      result.rerender(<RequirementDiscussion {...props} {...changes} />),
  };
}
afterEach(cleanup);

it("allows an incomplete goal or a knowledge question without manufacturing a card", () => {
  const view = {
    ...ready(),
    status: "discussing" as const,
    review: undefined,
    canConfirm: false,
    messages: [
      {
        id: "message",
        speaker: "assistant" as const,
        text: "想了解哪个模块的已有能力？",
        afterConfirmation: false,
      },
    ],
    knowledgeStatus: "missing" as const,
  };
  show(view);
  expect(
    screen.queryByRole("button", { name: "确认需求并生成" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("想了解哪个模块的已有能力？")).toBeVisible();
  expect(screen.getByText(/未找到不代表平台没有/)).toBeVisible();
});
it("shows complete requirements immediately, preserves source context and separates facts from suggestions", () => {
  show();
  expect(screen.getByText(/修改固定版本 2/)).toBeVisible();
  expect(screen.getByRole("button", { name: "确认需求并生成" })).toBeEnabled();
  expect(screen.getByText("用户已明确")).toBeVisible();
  expect(screen.getByText("建议，确认后采用")).toBeVisible();
  fireEvent.click(screen.getAllByText("活动配置手册 · 模板规则")[0]!);
  expect(
    screen.getAllByText("知识发布 workbench-1.0.0 · 版本 3")[0],
  ).toBeVisible();
});
it.each([
  "dirty",
  "stale",
  "blocking",
  "viewer",
  "not-ready",
  "searching",
  "analyzing",
])("blocks confirmation for %s", async (reason) => {
  const view = ready();
  if (reason === "stale") view.reviewCurrent = false;
  if (reason === "not-ready") view.canConfirm = false;
  if (reason === "searching") view.knowledgeStatus = "searching";
  if (reason === "analyzing") view.status = "analyzing";
  if (reason === "blocking")
    view.questions = [
      {
        id: "money",
        question: "领取上限是否影响已发奖品？",
        reason: "涉及真实权益和资损",
        blocking: true,
        evidenceIds: [],
      },
    ];
  const result = show(view, {
    dirtyInput: reason === "dirty",
    canEdit: reason !== "viewer",
  });
  const confirm = screen.getByRole("button", { name: "确认需求并生成" });
  expect(confirm).toBeDisabled();
  fireEvent.click(confirm);
  expect(result.props.onConfirm).not.toHaveBeenCalled();
});
it("requires explicit platform scope consent and invalidates it for a new summary", async () => {
  const view = ready();
  view.review!.platformChanges = ["改造全平台登录；需独立评估成本"];
  const result = show(view);
  const confirm = () => screen.getByRole("button", { name: "确认需求并生成" });
  expect(confirm()).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(confirm()).toBeEnabled();
  result.update({ view: { ...view, review: { ...view.review!, version: 3 } } });
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(confirm()).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(confirm());
  });
  expect(result.props.onConfirm).toHaveBeenCalledWith({
    id: "summary-one",
    version: 3,
    acceptPlatformChanges: true,
  });
});
it("submits the exact review once while pending and after acknowledgement", async () => {
  let finish!: () => void;
  const callback = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  show(ready(), { onConfirm: callback });
  const confirm = screen.getByRole("button", { name: "确认需求并生成" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith({
    id: "summary-one",
    version: 2,
    acceptPlatformChanges: false,
  });
  await act(async () => {
    finish();
  });
  expect(confirm).toBeDisabled();
  expect(screen.getByText(/已提交确认/)).toBeVisible();
});
it("shows recoverable confirmation failure without auto-retrying or approving a different review", async () => {
  const result = show(ready(), {
    onConfirm: vi
      .fn()
      .mockRejectedValue(new Error("内容已更新，请核对最新摘要")),
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "确认需求并生成" }));
  });
  expect(screen.getByRole("alert")).toHaveTextContent("内容已更新");
  result.update({ view: { ...ready(), confirmationPending: true } });
  expect(screen.getByRole("button", { name: "确认需求并生成" })).toBeDisabled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "恢复确认结果" }));
  });
  expect(result.props.onRecoverConfirmation).toHaveBeenCalledTimes(1);
  expect(result.props.onConfirm).toHaveBeenCalledTimes(1);
});
it("keeps generation baseline distinct from subsequent messages and escapes source content", () => {
  const view = ready();
  view.status = "generating";
  view.currentGeneration = {
    label: "正在生成原型",
    baseline: "summary-one / 2",
  };
  view.messages = [
    {
      id: "later",
      speaker: "user",
      text: '<script>alert("x")</script>',
      afterConfirmation: true,
    },
  ];
  show(view);
  fireEvent.click(screen.getByText("交流记录 · 1 条"));
  expect(screen.getByText(/后续讨论，未纳入本次生成/)).toBeVisible();
  expect(screen.getByText('<script>alert("x")</script>')).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("button", { name: "确认需求并生成" })).toBeDisabled();
});
it("does not leak an old operation or failure across project/thread scopes", async () => {
  let reject!: (cause: Error) => void;
  const result = show(ready(), {
    onConfirm: () =>
      new Promise<void>((_, failure) => {
        reject = failure;
      }),
  });
  fireEvent.click(screen.getByRole("button", { name: "确认需求并生成" }));
  result.update({
    view: { ...ready(), scopeKey: "other-user/other-project/other-thread" },
  });
  expect(screen.getByRole("button", { name: "确认需求并生成" })).toBeEnabled();
  await act(async () => {
    reject(new Error("private old project failure"));
  });
  expect(
    screen.queryByText("private old project failure"),
  ).not.toBeInTheDocument();
});

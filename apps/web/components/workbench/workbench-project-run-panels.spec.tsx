// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchGenerationProcess } from "./workbench-generation-process";
import { isRetryableRun } from "../../lib/workbench/features/workbench-run-actions";
import {
  LeftInspector,
  MobileRunStatus,
  ProjectTranscriptPanel,
} from "./workbench-project-run-panels";

type TranscriptPanelProps = ComponentProps<typeof ProjectTranscriptPanel>;

const baseProps: TranscriptPanelProps = {
  actionBusy: false,
  activities: [],
  cancellationReason: null,
  canRetry: false,
  failure: null,
  generationProgress: 30,
  generationStage: null,
  isPrdRun: true,
  isOverview: false,
  messages: [],
  onRetry: vi.fn(),
  phase: "generating",
  projectMode: "document",
  prompt: "",
  runPhaseLabel: "正在整理需求结构",
  runStatus: "running",
  selectedTask: null,
  submissionError: null,
};

afterEach(cleanup);

describe("LeftInspector", () => {
  it("only exposes the fixed task stack at desktop widths", () => {
    const { container } = renderRunSurfaces({
      generationStage: "structuring-prd",
      projectMode: "document",
      runPhaseLabel: "正在生成需求文档",
    });

    const taskStack = container.querySelector<HTMLElement>("[data-left-task-stack]");
    expect(taskStack).not.toBeNull();
    expect(taskStack!.classList.contains("max-xl:hidden")).toBe(true);
  });
});

describe("ProjectTranscriptPanel", () => {
  it.each(["desktop", "mobile"] as const)("keeps generation process in the upper %s status area", (device) => {
    const cancel = vi.fn();
    const process = <WorkbenchGenerationProcess
      activities={[
        { id: "knowledge:1", detail: "已读取项目约束", label: "知识库检索", status: "succeeded" },
        { id: "document:1", detail: "读取文档规范：需求文档结构规范", label: "文档规范", status: "succeeded" },
        { id: "deerflow:model", detail: "internal reasoning", label: "internal model", status: "running" },
      ]}
      generationStage="drafting-prd" knowledgeReleaseId="release-2026-11" runAttempt={2}
      runId="run-2026-11-10-abcdef123456" lastEventSequence={7}
      retryOfRunId="previous-run-123456" runStartedAt="2026-11-10T15:00:00.000Z" runStatus="running"
      previews={[{ artifactIndex: 0, kind: "prd", title: "采购审批", markdown: "## 业务规则\n提交后审批。", screens: [] }]}
      variant={device === "mobile" ? "popover" : "inline"}
    />;
    const { container } = render(device === "desktop"
      ? <ProjectTranscriptPanel {...baseProps} canCancel onCancel={cancel} generationProcess={process} />
      : <MobileRunStatus busy={false} canCancel canRetry={false} failure={null}
          generationStage="drafting-prd" isPrdRun onCancel={cancel} onRetry={vi.fn()}
          prompt="采购审批" runPhaseLabel={null} runStatus="running" generationProcess={process} />);
    const anchor = container.querySelector(device === "desktop" ? '[data-panel-motion="agent-card"]' : "[data-mobile-run-status]")!;
    fireEvent.click(within(anchor as HTMLElement).getByRole("button", { name: "查看生成过程" }));
    expect(anchor.contains(screen.getByRole("region", { name: "生成过程" }))).toBe(true);
    expect(screen.getByText("当前文档结构")).toBeTruthy();
    expect(screen.getByText("业务规则")).toBeTruthy();
    expect(screen.getByText(/已读取项目约束/)).toBeTruthy();
    expect(screen.getByText(/需求文档结构规范/)).toBeTruthy();
    expect(screen.getByTestId("generation-timeline-progress").getAttribute("style")).toContain("width: 80%");
    expect(screen.getByText("已绑定知识版本")).toBeTruthy();
    expect(screen.getByText("release-2026-11")).toBeTruthy();
    expect(screen.getByText("运行标识")).toBeTruthy();
    expect(screen.getByText("run-2026…123456")).toBeTruthy();
    expect(screen.getByText(/第 2 次尝试/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看尝试诊断" }));
    expect(screen.getByText("运行状态")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("重试自 previous…123456")).toBeTruthy();
    expect(screen.getByText(/已接收 7 个有序事件/)).toBeTruthy();
    expect(screen.getByText(/生命周期/)).toBeTruthy();
    expect(screen.queryByText("internal reasoning")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起生成过程" }));
    expect(screen.queryByRole("region", { name: "生成过程" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消当前运行" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("shows cancellation attribution in the active attempt diagnostics", () => {
    render(
      <WorkbenchGenerationProcess
        cancellationReason="用户请求停止当前运行"
        generationStage="thinking"
        previews={[]}
        runAttempt={3}
        runId="run-cancelled"
        runStatus="cancelling"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看生成过程" }));
    fireEvent.click(screen.getByRole("button", { name: "查看尝试诊断" }));

    expect(screen.getByText("正在取消")).toBeTruthy();
    expect(screen.getByText("用户请求停止当前运行")).toBeTruthy();
  });

  it("keeps a queued PRD contextual before the first stage event", () => {
    const { container } = renderRunSurfaces({
      generationStage: null,
      projectMode: "document",
      runPhaseLabel: null,
      runStatus: "queued",
    });
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>("[data-mobile-run-status]");

    expect(agentCard.style.height).toBe("auto");
    expect(agentCard.dataset.prdBodyless).toBeUndefined();
    expect(within(agentCard).getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(within(agentCard).getByText("正在处理需求文档，当前阶段：准备中")).not.toBeNull();
    expect(within(agentCard).getByText("准备中")).not.toBeNull();
    expect(agentCard.querySelector(".workbench-status-spinner")).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(mobileStatus!).getByText("准备中")).not.toBeNull();
    expect(within(mobileStatus!).getByText("生成支付改造需求说明书")).not.toBeNull();
  });

  it("keeps an active PRD run expanded with prompt and stage context", () => {
    const { container } = renderPanel({
      generationStage: "structuring-prd",
      prompt: "生成支付改造需求说明书",
      runPhaseLabel: "正在生成需求文档",
    });
    const card = getAgentCard(container);

    expect(card.style.height).toBe("auto");
    expect(card.style.width).toBe("280px");
    expect(card.dataset.prdBodyless).toBeUndefined();
    expect(screen.getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(screen.getAllByText("规划结构")).toHaveLength(1);
    expect(screen.getByText("正在处理需求文档，当前阶段：规划结构")).not.toBeNull();
    expect(screen.queryByText("正在生成需求文档")).toBeNull();
    expect(card.querySelector(".workbench-status-spinner")).not.toBeNull();
    expect(card.querySelectorAll(".workbench-agent-bubble > span > span")).toHaveLength(2);
  });

  it.each([
    ["collecting-prd-context", "整理资料"],
    ["structuring-prd", "规划结构"],
    ["drafting-prd", "编写说明书"],
    ["validating-prd", "检查说明书"],
  ] as const)("projects the PRD stage %s as the short status %s on every run surface", (generationStage, expectedCopy) => {
    const { container } = renderRunSurfaces({
      generationStage,
      projectMode: "document",
      runPhaseLabel: "正在生成需求文档",
    });

    const taskStack = container.querySelector<HTMLElement>('[data-panel-motion="task-stack"]');
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(taskStack).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(taskStack!).getAllByText(expectedCopy)).toHaveLength(2);
    expect(within(agentCard).getAllByText(expectedCopy)).toHaveLength(1);
    expect(within(agentCard).getByText(`正在处理需求文档，当前阶段：${expectedCopy}`)).not.toBeNull();
    expect(within(mobileStatus!).getByText(expectedCopy)).not.toBeNull();
    expect(screen.queryByText("正在生成需求文档")).toBeNull();
    expect(agentCard.dataset.prdBodyless).toBeUndefined();
  });

  it("uses a neutral PRD preparation label before the first real stage event", () => {
    const { container } = renderRunSurfaces({
      generationStage: null,
      projectMode: "document",
      runPhaseLabel: "正在生成需求文档",
    });

    const taskStack = container.querySelector<HTMLElement>('[data-panel-motion="task-stack"]');
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(taskStack).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(taskStack!).getAllByText("准备中")).toHaveLength(2);
    expect(within(agentCard).getAllByText("准备中")).toHaveLength(1);
    expect(within(agentCard).getByText("正在处理需求文档，当前阶段：准备中")).not.toBeNull();
    expect(within(mobileStatus!).getByText("准备中")).not.toBeNull();
    expect(screen.queryByText("正在生成需求文档")).toBeNull();
  });

  it("shows the real understanding stage instead of the pre-event fallback", () => {
    const { container } = renderRunSurfaces({
      generationStage: "thinking",
      projectMode: "document",
      runPhaseLabel: "正在生成需求文档",
    });

    expect(screen.getAllByText("理解需求")).toHaveLength(4);
    expect(screen.queryByText("准备中")).toBeNull();
    expect(screen.queryByText("正在生成需求文档")).toBeNull();
    expect(getAgentCard(container).dataset.prdBodyless).toBeUndefined();
  });

  it.each([
    ["succeeded", "运行已完成"],
    ["failed", "运行失败"],
    ["cancelled", "运行已取消"],
  ] as const)("does not retain a stale PRD phase label after a %s Run", (runStatus, expectedCopy) => {
    const { container } = renderRunSurfaces({
      generationStage: "validating-prd",
      projectMode: "document",
      runPhaseLabel: "正在发布需求说明书",
      runStatus,
    });

    const taskStack = container.querySelector<HTMLElement>('[data-panel-motion="task-stack"]');
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>('[aria-live="polite"]');
    expect(taskStack).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(taskStack!).getAllByText(expectedCopy).length).toBeGreaterThan(0);
    expect(within(agentCard).getByText(expectedCopy)).not.toBeNull();
    expect(within(mobileStatus!).getByText(expectedCopy)).not.toBeNull();
    expect(screen.queryByText("正在发布需求说明书")).toBeNull();
  });

  it("leaves prototype-only stage copy and ellipsis behavior unchanged", () => {
    const { container } = renderRunSurfaces({
      generationStage: "generating-ui",
      projectMode: "generated",
      runPhaseLabel: "正在生成真实结算界面",
    });
    const card = getAgentCard(container);
    const taskStack = container.querySelector<HTMLElement>('[data-panel-motion="task-stack"]');
    const mobileStatus = container.querySelector<HTMLElement>('[aria-live="polite"]');

    expect(taskStack).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(taskStack!).getAllByText("正在生成真实结算界面")).toHaveLength(2);
    expect(within(mobileStatus!).getByText("正在生成真实结算界面")).not.toBeNull();
    expect(card.textContent).toContain("正在生成真实结算界面...");
    expect(card.dataset.prdBodyless).toBeUndefined();
    expect(container.querySelectorAll(".workbench-stage-ellipsis")).toHaveLength(2);
  });

  it("preserves a prototype status while the selected canvas is still a document", () => {
    const { container } = renderRunSurfaces({
      generationStage: null,
      isPrdRun: false,
      projectMode: "document",
      runPhaseLabel: "正在准备原型生成",
    });

    expect(screen.getAllByText("正在准备原型生成")).toHaveLength(4);
    expect(screen.queryByText("准备中")).toBeNull();
    expect(getAgentCard(container).dataset.prdBodyless).toBeUndefined();
  });

  it("keeps active PRD generation contextual across streaming assistant deltas", () => {
    const rendered = renderPanel({
      generationStage: "structuring-prd",
      prompt: "生成支付改造需求说明书",
    });
    expect(getAgentCard(rendered.container).style.height).toBe("auto");
    expect(screen.getByText("生成支付改造需求说明书")).not.toBeNull();

    rendered.rerender(panelElement({
      generationStage: "structuring-prd",
      messages: [{ id: "message-1", status: "streaming", text: "正在梳理业务规则", working: true }],
      prompt: "生成支付改造需求说明书",
    }));
    expect(getAgentCard(rendered.container).style.height).toBe("auto");
    expect(screen.getByText("正在梳理业务规则")).not.toBeNull();
    expect(screen.getByText("规划结构")).not.toBeNull();

    rendered.rerender(panelElement({
      generationStage: "drafting-prd",
      messages: [
        { id: "message-1", status: "streaming", text: "正在梳理业务规则", working: true },
        { id: "message-2", status: "streaming", text: "正在补充验收标准", working: true },
      ],
      prompt: "生成支付改造需求说明书",
    }));
    const card = getAgentCard(rendered.container);
    expect(card.style.height).toBe("auto");
    expect(card.style.maxHeight).toBe("");
    expect(card.dataset.prdBodyless).toBeUndefined();
    expect(screen.getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(screen.getByText("正在补充验收标准")).not.toBeNull();
    expect(card.dataset.generationStage).toBe("drafting-prd");
  });

  it("keeps PRD context visible while cancellation is in progress", () => {
    const { container } = renderRunSurfaces({
      generationStage: "drafting-prd",
      projectMode: "document",
      runPhaseLabel: "正在编写需求说明书",
      runStatus: "cancelling",
    });
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>("[data-mobile-run-status]");

    expect(agentCard.style.height).toBe("auto");
    expect(within(agentCard).getByText("正在取消")).not.toBeNull();
    expect(within(agentCard).getByText("正在停止需求文档生成，请稍候。")).not.toBeNull();
    expect(within(agentCard).getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(mobileStatus!).getByText("正在取消")).not.toBeNull();
    expect(within(mobileStatus!).getByText("生成支付改造需求说明书")).not.toBeNull();
  });

  it.each([
    {
      canRetry: true,
      cancellationReason: null,
      expectedDetail: "模型服务暂时不可用",
      expectedRetry: true,
      expectedStatus: "运行失败",
      failure: { code: "RUNTIME_UNAVAILABLE", message: "模型服务暂时不可用", retryable: true },
      runStatus: "failed" as const,
    },
    {
      canRetry: false,
      cancellationReason: "已由当前用户取消",
      expectedDetail: "已由当前用户取消",
      expectedRetry: false,
      expectedStatus: "运行已取消",
      failure: null,
      runStatus: "cancelled" as const,
    },
  ])("keeps terminal PRD context and retry behavior after $runStatus", ({
    canRetry,
    cancellationReason,
    expectedDetail,
    expectedRetry,
    expectedStatus,
    failure,
    runStatus,
  }) => {
    const onRetry = vi.fn();
    const { container } = renderPanel({
      cancellationReason,
      canRetry,
      failure,
      generationStage: "validating-prd",
      onRetry,
      phase: "idle",
      prompt: "生成支付改造需求说明书",
      runStatus,
    });
    const agentCard = getAgentCard(container);

    expect(agentCard.style.height).toBe("auto");
    expect(agentCard.dataset.prdBodyless).toBeUndefined();
    expect(within(agentCard).getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(within(agentCard).getByText(expectedDetail)).not.toBeNull();
    expect(within(agentCard).getByText(expectedStatus)).not.toBeNull();
    expect(agentCard.querySelector(".workbench-status-spinner")).toBeNull();
    const retry = within(agentCard).queryByRole("button", { name: "重试当前运行" });
    if (expectedRetry) {
      expect(retry).not.toBeNull();
      fireEvent.click(retry!);
      expect(onRetry).toHaveBeenCalledOnce();
    } else {
      expect(retry).toBeNull();
      expect(onRetry).not.toHaveBeenCalled();
    }
  });

  it("shows the persisted failure detail before a generic terminal assistant message", () => {
    const { container } = renderPanel({
      failure: {
        code: "RUNTIME_EXECUTION_FAILED",
        message: "RUNTIME_ARTIFACTS_MISSING:prototype",
        retryable: false,
      },
      messages: [{
        id: "message-1",
        status: "completed",
        text: "RUNTIME_EXECUTION_FAILED",
        working: false,
      }],
      prompt: "根据这个文档生成原型",
      runStatus: "failed",
    });

    expect(within(getAgentCard(container)).getByText("RUNTIME_ARTIFACTS_MISSING:prototype")).not.toBeNull();
  });

  it("shows provider filtering on desktop and mobile without offering a retry", () => {
    const failure = {
      code: "RUNTIME_PROVIDER_CONTENT_FILTERED",
      message: "模型服务商拦截了本次输出，任务已停止。",
      retryable: false,
    };
    const canRetry = isRetryableRun({ status: "failed", failure });
    const onRetry = vi.fn();
    const { container } = render(
      <>
        {panelElement({
          canRetry,
          failure,
          isPrdRun: false,
          messages: [{ id: "message-1", status: "completed", text: "}\n", working: false }],
          onRetry,
          prompt: "生成一个普通业务页面",
          runStatus: "failed",
        })}
        <MobileRunStatus
          busy={false}
          canCancel={false}
          canRetry={canRetry}
          failure={failure}
          generationStage={null}
          isPrdRun={false}
          onCancel={vi.fn()}
          onRetry={onRetry}
          prompt="生成一个普通业务页面"
          runPhaseLabel={null}
          runStatus="failed"
        />
      </>,
    );

    const mobileStatus = container.querySelector<HTMLElement>("[data-mobile-run-status]");
    expect(within(getAgentCard(container)).getByText(failure.message)).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(within(mobileStatus!).getByText(failure.message)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "重试当前运行" })).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("restores queued PRD context on retry and keeps it deterministic after reconnect", () => {
    const onRetry = vi.fn();
    const rendered = renderPanel({
      canRetry: true,
      failure: { code: "RUNTIME_TIMEOUT", message: "运行超时", retryable: true },
      generationStage: "validating-prd",
      onRetry,
      phase: "idle",
      prompt: "生成支付改造需求说明书",
      runStatus: "failed",
    });
    const originalCard = getAgentCard(rendered.container);
    fireEvent.click(within(originalCard).getByRole("button", { name: "重试当前运行" }));

    rendered.rerender(panelElement({
      canRetry: false,
      failure: null,
      generationStage: null,
      phase: "generating",
      prompt: "生成支付改造需求说明书",
      runPhaseLabel: null,
      runStatus: "queued",
    }));
    expect(getAgentCard(rendered.container)).toBe(originalCard);
    expect(within(originalCard).getByText("正在处理需求文档，当前阶段：准备中")).not.toBeNull();
    expect(within(originalCard).getByText("生成支付改造需求说明书")).not.toBeNull();

    rendered.rerender(panelElement({
      canRetry: false,
      failure: null,
      generationStage: "drafting-prd",
      messages: [],
      phase: "generating",
      prompt: "生成支付改造需求说明书",
      runPhaseLabel: "正在恢复运行事件",
      runStatus: "running",
    }));
    expect(getAgentCard(rendered.container)).toBe(originalCard);
    expect(within(originalCard).getByText("正在处理需求文档，当前阶段：编写说明书")).not.toBeNull();
    expect(within(originalCard).getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(screen.queryByText("正在恢复运行事件")).toBeNull();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps PRD semantics and bounded responsive surfaces under reduced motion", () => {
    const { container } = render(
      <MotionConfig reducedMotion="always">
        {panelElement({
          generationStage: "drafting-prd",
          prompt: "生成支付改造需求说明书",
          runStatus: "running",
        })}
        <MobileRunStatus
          busy={false}
          canCancel={false}
          canRetry={false}
          failure={null}
          generationStage="drafting-prd"
          isPrdRun
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          prompt="生成支付改造需求说明书"
          runPhaseLabel="正在恢复运行事件"
          runStatus="running"
        />
      </MotionConfig>,
    );
    const agentCard = getAgentCard(container);
    const mobileStatus = container.querySelector<HTMLElement>("[data-mobile-run-status]");

    expect(agentCard.style.width).toBe("280px");
    expect(agentCard.style.height).toBe("auto");
    expect(agentCard.classList.contains("left-[16px]")).toBe(true);
    expect(agentCard.classList.contains("max-md:hidden")).toBe(true);
    expect(within(agentCard).getByText("正在处理需求文档，当前阶段：编写说明书")).not.toBeNull();
    expect(mobileStatus).not.toBeNull();
    expect(mobileStatus!.classList.contains("left-[16px]")).toBe(true);
    expect(mobileStatus!.classList.contains("right-[70px]")).toBe(true);
    expect(mobileStatus!.classList.contains("md:hidden")).toBe(true);
    expect(within(mobileStatus!).getByText("生成支付改造需求说明书")).not.toBeNull();

    const desktopCardRight = 16 + Number.parseInt(agentCard.style.width, 10);
    for (const viewportWidth of [768, 1_440]) {
      expect(desktopCardRight).toBeLessThanOrEqual(viewportWidth);
    }
    expect(375 - 16 - 70).toBeGreaterThan(0);
  });

  it.each(["succeeded", "failed"] as const)("keeps PRD %s terminal content expanded", (runStatus) => {
    const { container } = renderPanel({
      messages: [{ id: "message-1", status: "completed", text: "已完成需求说明书", working: false }],
      prompt: "生成支付改造需求说明书",
      runStatus,
    });

    expect(getAgentCard(container).style.height).toBe("auto");
    expect(screen.getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(screen.getByText("已完成需求说明书")).not.toBeNull();
  });

  it("expands an active PRD when the user selects a history task", () => {
    const { container } = renderPanel({
      activities: [{
        detail: "已完成业务规则梳理",
        id: "activity-1",
        label: "梳理业务规则",
        status: "succeeded",
        terminal: true,
        working: false,
      }],
      messages: [{ id: "message-1", status: "streaming", text: "正在补充验收标准", working: true }],
      selectedTask: "梳理业务规则",
    });

    expect(getAgentCard(container).style.height).toBe("auto");
    expect(screen.getByText("梳理业务规则")).not.toBeNull();
    expect(screen.getByText("已完成业务规则梳理")).not.toBeNull();
  });

  it("ignores a task selection that does not belong to the current Run", () => {
    const { container } = renderPanel({
      activities: [],
      generationStage: null,
      prompt: "生成本次支付改造需求说明书",
      runStatus: "running",
      selectedTask: "上一次运行的旧任务",
    });

    expect(getAgentCard(container).style.height).toBe("auto");
    expect(screen.queryByText("上一次运行的旧任务")).toBeNull();
    expect(screen.getByText("生成本次支付改造需求说明书")).not.toBeNull();
    expect(screen.getByText("正在处理需求文档，当前阶段：准备中")).not.toBeNull();
  });

  it("keeps non-PRD streaming content expanded", () => {
    const { container } = renderPanel({
      generationStage: "generating-ui",
      isPrdRun: false,
      messages: [{ id: "message-1", status: "streaming", text: "正在生成真实界面", working: true }],
      prompt: "生成会员中心原型",
      projectMode: "document",
      runPhaseLabel: "正在生成真实界面",
    });

    expect(getAgentCard(container).style.height).toBe("auto");
    expect(screen.getByText("生成会员中心原型")).not.toBeNull();
    expect(screen.getAllByText("正在生成真实界面")).toHaveLength(2);
  });

  it("reserves the full history height for a selected task", () => {
    const { container } = renderPanel({
      activities: [{
        detail: "已完成业务规则梳理",
        id: "activity-1",
        label: "梳理业务规则",
        status: "succeeded",
        terminal: true,
        working: false,
      }],
      runStatus: "succeeded",
      selectedTask: "梳理业务规则",
    });

    expect(getAgentCard(container).style.height).toBe("auto");
  });
});

function renderPanel(overrides: Partial<TranscriptPanelProps> = {}) {
  return render(panelElement(overrides));
}

function renderRunSurfaces({
  generationStage,
  projectMode,
  isPrdRun = projectMode === "document",
  runPhaseLabel,
  runStatus = "running",
}: Pick<TranscriptPanelProps, "generationStage" | "projectMode" | "runPhaseLabel"> & {
  isPrdRun?: boolean;
  runStatus?: TranscriptPanelProps["runStatus"];
}) {
  return render(
    <>
      <LeftInspector
        actionBusy={false}
        activities={[]}
        canCancel={false}
        generationProgress={0}
        generationStage={generationStage}
        isPrdRun={isPrdRun}
        isOverview={false}
        onCancel={vi.fn()}
        onSelectTask={vi.fn()}
        phase="generating"
        projectMode={projectMode}
        prompt="生成支付改造需求说明书"
        runPhaseLabel={runPhaseLabel}
        runStatus={runStatus}
        selectedTask={null}
        zoomLabel="100%"
      />
      {panelElement({
        generationStage,
        isPrdRun,
        projectMode,
        prompt: "生成支付改造需求说明书",
        runPhaseLabel,
        runStatus,
      })}
      <MobileRunStatus
        busy={false}
        canCancel={false}
        canRetry={false}
        failure={null}
        generationStage={generationStage}
        isPrdRun={isPrdRun}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        prompt="生成支付改造需求说明书"
        runPhaseLabel={runPhaseLabel}
        runStatus={runStatus}
      />
    </>,
  );
}

function panelElement(overrides: Partial<TranscriptPanelProps> = {}) {
  return <ProjectTranscriptPanel {...baseProps} {...overrides} />;
}

function getAgentCard(container: HTMLElement) {
  const card = container.querySelector<HTMLElement>('[data-panel-motion="agent-card"]');
  expect(card).not.toBeNull();
  return card!;
}

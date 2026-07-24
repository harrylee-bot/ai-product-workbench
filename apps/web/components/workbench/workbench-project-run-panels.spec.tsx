// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("ProjectTranscriptPanel", () => {
  it("keeps a bodyless PRD run compact without an invented empty-message paragraph", () => {
    const { container } = renderPanel({
      generationStage: "structuring-prd",
      prompt: "生成支付改造需求说明书",
      runPhaseLabel: "正在生成需求文档",
    });
    const card = getAgentCard(container);

    expect(card.style.height).toBe("126px");
    expect(card.style.maxHeight).toBe("126px");
    expect(card.style.minHeight).toBe("126px");
    expect(card.style.width).toBe("280px");
    expect(card.style.maxWidth).toBe("280px");
    expect(card.style.minWidth).toBe("280px");
    expect(card.dataset.prdBodyless).toBe("true");
    expect(screen.queryByText("暂无新的运行消息。")).toBeNull();
    expect(screen.queryByText("生成支付改造需求说明书")).toBeNull();
    expect(screen.getByText("规划结构")).not.toBeNull();
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
    expect(within(agentCard).getByText(expectedCopy)).not.toBeNull();
    expect(within(mobileStatus!).getByText(expectedCopy)).not.toBeNull();
    expect(screen.queryByText("正在生成需求文档")).toBeNull();
    expect(agentCard.dataset.prdBodyless).toBe("true");
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
    expect(within(agentCard).getByText("准备中")).not.toBeNull();
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
    expect(getAgentCard(container).dataset.prdBodyless).toBe("true");
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

  it("keeps active PRD generation compact across streaming assistant deltas", () => {
    const rendered = renderPanel({
      generationStage: "structuring-prd",
      prompt: "生成支付改造需求说明书",
    });
    expect(getAgentCard(rendered.container).style.height).toBe("126px");
    expect(screen.queryByText("生成支付改造需求说明书")).toBeNull();

    rendered.rerender(panelElement({
      generationStage: "structuring-prd",
      messages: [{ id: "message-1", status: "streaming", text: "正在梳理业务规则", working: true }],
      prompt: "生成支付改造需求说明书",
    }));
    expect(getAgentCard(rendered.container).style.height).toBe("126px");
    expect(screen.queryByText("正在梳理业务规则")).toBeNull();
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
    expect(card.style.height).toBe("126px");
    expect(card.style.maxHeight).toBe("126px");
    expect(card.dataset.prdBodyless).toBe("true");
    expect(screen.queryByText("生成支付改造需求说明书")).toBeNull();
    expect(screen.queryByText("正在梳理业务规则")).toBeNull();
    expect(screen.queryByText("正在补充验收标准")).toBeNull();
    expect(card.dataset.generationStage).toBe("drafting-prd");
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
      {panelElement({ generationStage, isPrdRun, projectMode, runPhaseLabel, runStatus })}
      <MobileRunStatus
        busy={false}
        canCancel={false}
        canRetry={false}
        failure={null}
        generationStage={generationStage}
        isPrdRun={isPrdRun}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
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

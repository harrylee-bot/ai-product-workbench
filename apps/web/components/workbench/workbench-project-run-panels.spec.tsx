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

  it("reveals the prompt chip only after substantive body content arrives", () => {
    const rendered = renderPanel({ prompt: "生成支付改造需求说明书" });
    expect(getAgentCard(rendered.container).style.height).toBe("126px");
    expect(screen.queryByText("生成支付改造需求说明书")).toBeNull();

    rendered.rerender(panelElement({
      messages: [{ id: "message-1", status: "streaming", text: "正在梳理业务规则", working: true }],
    }));
    expect(getAgentCard(rendered.container).style.height).toBe("auto");

    rendered.rerender(panelElement({
      messages: [{ id: "message-1", status: "streaming", text: "正在梳理业务规则", working: true }],
      prompt: "生成支付改造需求说明书",
    }));
    expect(getAgentCard(rendered.container).style.height).toBe("auto");
    expect(screen.getByText("生成支付改造需求说明书")).not.toBeNull();
    expect(screen.getByText("正在梳理业务规则").classList.contains("overflow-y-auto")).toBe(true);
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
}: Pick<TranscriptPanelProps, "generationStage" | "projectMode" | "runPhaseLabel"> & {
  isPrdRun?: boolean;
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
        runStatus="running"
        selectedTask={null}
        zoomLabel="100%"
      />
      {panelElement({ generationStage, isPrdRun, projectMode, runPhaseLabel })}
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
        runStatus="running"
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

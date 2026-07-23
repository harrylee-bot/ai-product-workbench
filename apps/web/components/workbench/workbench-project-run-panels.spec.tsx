// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectTranscriptPanel } from "./workbench-project-run-panels";

type TranscriptPanelProps = ComponentProps<typeof ProjectTranscriptPanel>;

const baseProps: TranscriptPanelProps = {
  actionBusy: false,
  activities: [],
  cancellationReason: null,
  canRetry: false,
  failure: null,
  generationProgress: 30,
  generationStage: null,
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
    const { container } = renderPanel({ prompt: "生成支付改造需求说明书" });
    const card = getAgentCard(container);

    expect(card.style.height).toBe("auto");
    expect(screen.queryByText("暂无新的运行消息。")).toBeNull();
    expect(screen.queryByText("生成支付改造需求说明书")).toBeNull();
    expect(screen.getByText("正在整理需求结构")).not.toBeNull();
    expect(card.querySelector(".workbench-status-spinner")).not.toBeNull();
    expect(card.querySelectorAll(".workbench-agent-bubble > span > span")).toHaveLength(2);
  });

  it("reveals the prompt chip only after substantive body content arrives", () => {
    const rendered = renderPanel({ prompt: "生成支付改造需求说明书" });
    expect(getAgentCard(rendered.container).style.height).toBe("auto");
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

function panelElement(overrides: Partial<TranscriptPanelProps> = {}) {
  return <ProjectTranscriptPanel {...baseProps} {...overrides} />;
}

function getAgentCard(container: HTMLElement) {
  const card = container.querySelector<HTMLElement>('[data-panel-motion="agent-card"]');
  expect(card).not.toBeNull();
  return card!;
}

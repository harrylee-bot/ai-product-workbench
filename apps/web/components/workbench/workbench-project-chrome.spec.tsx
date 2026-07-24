// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workbenchProjectCapabilities } from "@/lib/workbench/features/projects";

import {
  ProjectStageMotionFX,
  ProjectSuggestionPills,
  ProjectTopBar,
} from "./workbench-project-chrome";
import { RenameProjectDialog } from "./workbench-rename-dialog";

afterEach(cleanup);

describe("workbench project chrome", () => {
  it.each([
    "collecting-prd-context",
    "structuring-prd",
    "drafting-prd",
    "validating-prd",
  ] as const)("keeps the PRD canvas motion mounted at %s", (generationStage) => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage={generationStage}
        isOverview={false}
        isPrdRun
        phase="generating"
        projectMode="document"
      />,
    );

    const motion = container.querySelector('[data-canvas-generation-motion="prd"]');
    expect(motion).not.toBeNull();
    expect(motion?.getAttribute("data-generation-stage")).toBe(generationStage);
    expect(motion?.classList.contains("workbench-stage-phase-wash--prd")).toBe(true);
  });

  it("shows a static-capable PRD wash on reload before the durable stage arrives", () => {
    const rendered = render(
      <ProjectStageMotionFX
        generationStage={null}
        isOverview={false}
        isPrdRun
        phase="generating"
        projectMode="document"
      />,
    );

    const initialMotion = rendered.container.querySelector('[data-canvas-generation-motion="prd"]');
    expect(initialMotion).not.toBeNull();
    expect(initialMotion?.hasAttribute("data-generation-stage")).toBe(false);

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="drafting-prd"
        isOverview={false}
        isPrdRun
        phase="generating"
        projectMode="document"
      />,
    );

    const attachedMotion = rendered.container.querySelector('[data-canvas-generation-motion="prd"]');
    expect(attachedMotion).toBe(initialMotion);
    expect(attachedMotion?.getAttribute("data-generation-stage")).toBe("drafting-prd");
  });

  it("mounts PRD canvas motion when an active Run attaches after the document view", () => {
    const rendered = render(
      <ProjectStageMotionFX
        generationStage={null}
        isOverview={false}
        isPrdRun={false}
        phase="generating"
        projectMode="document"
      />,
    );
    expect(rendered.container.querySelector("[data-canvas-generation-motion]")).toBeNull();

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="validating-prd"
        isOverview={false}
        isPrdRun
        phase="refining"
        projectMode="document"
      />,
    );

    expect(rendered.container.querySelector('[data-canvas-generation-motion="prd"]'))
      .not.toBeNull();
  });

  it("does not leak PRD canvas motion into prototype or terminal document states", () => {
    const rendered = render(
      <ProjectStageMotionFX
        generationStage="drafting-prd"
        isOverview={false}
        isPrdRun={false}
        phase="generating"
        projectMode="document"
      />,
    );
    expect(rendered.container.querySelector("[data-canvas-generation-motion]")).toBeNull();

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="validating-prd"
        isOverview={false}
        isPrdRun
        phase="complete"
        projectMode="document"
      />,
    );
    expect(rendered.container.querySelector("[data-canvas-generation-motion]")).toBeNull();

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="generating-ui"
        isOverview={false}
        isPrdRun={false}
        phase="generating"
        projectMode="generated"
      />,
    );
    expect(rendered.container.querySelector('[data-canvas-generation-motion="prototype"]'))
      .not.toBeNull();
  });

  it("uses the 产品工作台 brand and preserves viewer command permissions", () => {
    const onPreview = vi.fn();
    render(
      <ProjectTopBar
        capabilities={workbenchProjectCapabilities("viewer")}
        exportOpen={false}
        onArchive={vi.fn()}
        onBack={vi.fn()}
        onDuplicate={vi.fn()}
        onExport={vi.fn()}
        onMembers={vi.fn()}
        onPreview={onPreview}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onToggleMenu={vi.fn()}
        projectMenuOpen
        projectTitle="结算体验优化"
        shareOpen={false}
      />,
    );

    expect(screen.getByText("产品工作台项目")).not.toBeNull();
    expect((screen.getByRole("button", { name: "预览项目" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "导出" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "共享" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("menuitem", { name: "重命名项目" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("menuitem", { name: "复制项目" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "预览项目" }));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith();
  });

  it("keeps the generated-project suggestion branded as 产品工作台", () => {
    render(
      <ProjectSuggestionPills
        disabled={false}
        onSelect={vi.fn()}
        phase="complete"
        projectMode="generated"
        zoomKeyActive={false}
        zoomLabel="63%"
      />,
    );

    expect(screen.getByText("贴士：让产品工作台优化设计中的特定部分")).not.toBeNull();
  });

  it("submits the normalized rename and closes after success", async () => {
    const onClose = vi.fn();
    const onRename = vi.fn(async () => undefined);
    render(
      <RenameProjectDialog
        currentTitle="旧标题"
        onClose={onClose}
        onRename={onRename}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  新标题  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("新标题"));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

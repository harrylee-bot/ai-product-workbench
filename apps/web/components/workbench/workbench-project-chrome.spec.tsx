// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workbenchProjectCapabilities } from "@/lib/workbench/features/projects";

import {
  ProjectStageMotionFX,
  ProjectSuggestionPills,
  ProjectTopBar,
  SelectedActionPill,
} from "./workbench-project-chrome";
import { RenameProjectDialog } from "./workbench-rename-dialog";

afterEach(cleanup);

describe("workbench project chrome", () => {
  it.each([
    null,
    "thinking",
    "collecting-prd-context",
    "structuring-prd",
    "drafting-prd",
    "validating-prd",
  ] as const)("uses the trusted PRD Run kind at stage %s", (generationStage) => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage={generationStage}
        isOverview={false}
        motionKind="prd"
        phase="generating"
      />,
    );

    const motion = container.querySelector('[data-canvas-generation-motion="prd"]');
    expect(motion).not.toBeNull();
    expect(motion?.getAttribute("data-generation-stage")).toBe(generationStage ?? null);
    expect(motion?.classList.contains("workbench-stage-phase-wash--prd")).toBe(true);
  });

  it.each([
    null,
    "thinking",
    "design-system",
    "generating-ui",
    "screen-stable",
  ] as const)("uses the trusted Prototype Run kind at stage %s", (generationStage) => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage={generationStage}
        isOverview={false}
        motionKind="prototype"
        phase="generating"
      />,
    );

    const motion = container.querySelector('[data-canvas-generation-motion="prototype"]');
    expect(motion).not.toBeNull();
    expect(motion?.getAttribute("data-generation-stage")).toBe(generationStage ?? null);
    expect(motion?.classList.contains("workbench-stage-phase-wash--prd")).toBe(false);
  });

  it.each([null, "thinking"] as const)(
    "keeps neutral Run motion unmounted at generic stage %s",
    (generationStage) => {
      const { container } = render(
        <ProjectStageMotionFX
          generationStage={generationStage}
          isOverview={false}
          motionKind="neutral"
          phase="generating"
        />,
      );

      expect(container.querySelector("[data-canvas-generation-motion]")).toBeNull();
    },
  );

  it.each([
    ["drafting-prd", "prd"],
    ["generating-ui", "prototype"],
  ] as const)("uses validated stage %s when the Run motion kind is neutral", (generationStage, expectedKind) => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage={generationStage}
        isOverview={false}
        motionKind="neutral"
        phase="generating"
      />,
    );

    const motion = container.querySelector(
      `[data-canvas-generation-motion="${expectedKind}"]`,
    );
    expect(motion).not.toBeNull();
    expect(motion?.getAttribute("data-generation-stage")).toBe(generationStage);
  });

  it.each([
    ["prd", "generating-ui"],
    ["prototype", "drafting-prd"],
  ] as const)("fails neutral when trusted %s motion conflicts with stage %s", (motionKind, generationStage) => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage={generationStage}
        isOverview={false}
        motionKind={motionKind}
        phase="generating"
      />,
    );

    expect(container.querySelector("[data-canvas-generation-motion]")).toBeNull();
  });

  it.each(["complete", "idle"] as const)("clears motion when the project phase becomes %s", async (phase) => {
    const rendered = render(
      <ProjectStageMotionFX
        generationStage="drafting-prd"
        isOverview={false}
        motionKind="prd"
        phase="generating"
      />,
    );
    expect(rendered.container.querySelector('[data-canvas-generation-motion="prd"]')).not.toBeNull();

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="drafting-prd"
        isOverview={false}
        motionKind="prd"
        phase={phase}
      />,
    );

    await waitFor(() => {
      expect(rendered.container.querySelector("[data-canvas-generation-motion]")).toBeNull();
    });
  });

  it("projects the same Prototype motion across startup and reconnect stage updates", () => {
    const rendered = render(
      <ProjectStageMotionFX
        generationStage={null}
        isOverview={false}
        motionKind="prototype"
        phase="generating"
      />,
    );
    const initialMotion = rendered.container.querySelector(
      '[data-canvas-generation-motion="prototype"]',
    );
    expect(initialMotion).not.toBeNull();

    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="thinking"
        isOverview={false}
        motionKind="prototype"
        phase="generating"
      />,
    );
    rendered.rerender(
      <ProjectStageMotionFX
        generationStage="generating-ui"
        isOverview={false}
        motionKind="prototype"
        phase="generating"
      />,
    );

    const reconnectedMotion = rendered.container.querySelector(
      '[data-canvas-generation-motion="prototype"]',
    );
    expect(reconnectedMotion).toBe(initialMotion);
    expect(reconnectedMotion?.getAttribute("data-generation-stage")).toBe("generating-ui");
  });

  it("keeps motion semantics mounted when reduced motion is required", () => {
    const { container } = render(
      <MotionConfig reducedMotion="always">
        <ProjectStageMotionFX
          generationStage="thinking"
          isOverview={false}
          motionKind="prototype"
          phase="generating"
        />
      </MotionConfig>,
    );

    expect(container.querySelector('[data-canvas-generation-motion="prototype"]')).not.toBeNull();
  });

  it.each([
    ["prd", "document", "正在生成：需求文档"],
    ["prototype", "prototype", "正在生成：原型界面"],
  ] as const)(
    "renders a transient %s pending surface before the first real artifact node exists",
    (motionKind, variant, label) => {
      const { container } = render(
        <ProjectStageMotionFX
          generationStage="thinking"
          isOverview={false}
          motionKind={motionKind}
          phase="generating"
          showPendingArtifact
        />,
      );

      expect(container.querySelector(
        `[data-workbench-transient-artifact="${motionKind}"]`,
      )).not.toBeNull();
      expect(container.querySelector(
        `[data-workbench-artifact-state="pending"][data-workbench-artifact-variant="${variant}"]`,
      )).not.toBeNull();
      expect(screen.getByText(label)).not.toBeNull();
      expect(container.querySelector(".react-flow__node")).toBeNull();
      expect(container.querySelector("[data-workbench-generated-node]")).toBeNull();
    },
  );

  it.each([
    ["complete", "prd", "validating-prd"],
    ["generating", "prd", "generating-ui"],
    ["generating", "neutral", "thinking"],
  ] as const)(
    "does not render a transient artifact for phase %s, motion %s, stage %s",
    (phase, motionKind, generationStage) => {
      const { container } = render(
        <ProjectStageMotionFX
          generationStage={generationStage}
          isOverview={false}
          motionKind={motionKind}
          phase={phase}
          showPendingArtifact
        />,
      );

      expect(container.querySelector("[data-workbench-transient-artifact]")).toBeNull();
    },
  );

  it("does not mount Prototype motion over the generated overview field", () => {
    const { container } = render(
      <ProjectStageMotionFX
        generationStage="thinking"
        isOverview
        motionKind="prototype"
        phase="generating"
      />,
    );

    expect(container.querySelector("[data-canvas-generation-motion]")).toBeNull();
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

  it("keeps Preview, Export, and Share named and operable at the 375px base breakpoint", () => {
    const onPreview = vi.fn();
    render(
      <ProjectTopBar
        capabilities={workbenchProjectCapabilities("owner")}
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
        projectMenuOpen={false}
        projectTitle="结算体验优化"
        shareOpen={false}
      />,
    );

    const preview = screen.getByRole("button", { name: "预览项目" });
    const exportButton = screen.getByRole("button", { name: "导出" });
    const share = screen.getByRole("button", { name: "共享" });
    expect(preview.classList.contains("hidden")).toBe(false);
    expect(preview.getAttribute("data-project-action")).toBe("preview");
    expect(exportButton.getAttribute("data-project-action")).toBe("export");
    expect(share.getAttribute("data-project-action")).toBe("share");

    fireEvent.click(preview);
    expect(onPreview).toHaveBeenCalledOnce();
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

  it("unmounts selected-node actions for the full lifetime of an active Run", () => {
    const props = {
      availability: {
        canCopyLink: true,
        canDelete: true,
        canDuplicate: true,
        canRename: true,
      },
      canOpenVersions: true,
      menuOpen: false,
      onCopyLink: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onOpenVersions: vi.fn(),
      onRename: vi.fn(),
      onToggleMenu: vi.fn(),
      open: true,
    };
    const rendered = render(<SelectedActionPill {...props} activeRun={false} />);

    expect(rendered.container.querySelector("[data-selected-action]")).not.toBeNull();
    rendered.rerender(<SelectedActionPill {...props} activeRun />);
    expect(rendered.container.querySelector("[data-selected-action]")).toBeNull();
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

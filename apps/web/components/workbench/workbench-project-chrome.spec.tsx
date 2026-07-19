// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workbenchProjectCapabilities } from "@/lib/workbench/features/projects";

import {
  ProjectSuggestionPills,
  ProjectTopBar,
} from "./workbench-project-chrome";
import { RenameProjectDialog } from "./workbench-rename-dialog";

afterEach(cleanup);

describe("workbench project chrome", () => {
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

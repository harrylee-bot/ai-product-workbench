// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchBoardConflictDialog } from "./workbench-board-conflict-dialog";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? children : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

afterEach(() => cleanup());

describe("Workbench Board conflict dialog", () => {
  it("exposes export, discard, and explicit local replay commands", () => {
    const onExport = vi.fn();
    const onDiscard = vi.fn(async () => undefined);
    const onReplay = vi.fn(async () => undefined);
    render(
      <WorkbenchBoardConflictDialog
        action={null}
        error={null}
        onDiscard={onDiscard}
        onExport={onExport}
        onOpenChange={vi.fn()}
        onReplay={onReplay}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "导出本地副本" }));
    fireEvent.click(screen.getByRole("button", { name: "使用服务器版本" }));
    fireEvent.click(screen.getByRole("button", { name: "使用本地版本" }));

    expect(onExport).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onReplay).toHaveBeenCalledOnce();
  });

  it("locks every command while a resolution is in flight and reports failure", () => {
    render(
      <WorkbenchBoardConflictDialog
        action="replay"
        error="服务器版本再次变化，请重新确认"
        onDiscard={vi.fn(async () => undefined)}
        onExport={vi.fn()}
        onOpenChange={vi.fn()}
        onReplay={vi.fn(async () => undefined)}
        open
      />,
    );

    expect(screen.getByText("服务器版本再次变化，请重新确认")).not.toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

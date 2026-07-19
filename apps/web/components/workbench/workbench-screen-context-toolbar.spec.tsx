// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateContextMenuPlacement,
  calculateToolbarCollisionOffset,
  WorkbenchScreenContextToolbar,
  type WorkbenchScreenContextToolbarAvailability,
  type WorkbenchScreenContextToolbarProps,
} from "./workbench-screen-context-toolbar";

vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: ReactNode }) => (
    <div data-testid="node-toolbar">{children}</div>
  ),
  Position: { Top: "top" },
}));

afterEach(cleanup);

describe("WorkbenchScreenContextToolbar", () => {
  it("renders nothing without a selection", () => {
    render(<WorkbenchScreenContextToolbar {...handlers()} model={null} />);
    expect(screen.queryByTestId("node-toolbar")).toBeNull();
  });

  it("renders the complete single-screen surface and routes More actions", () => {
    const actions = handlers();
    render(
      <WorkbenchScreenContextToolbar
        {...actions}
        model={{
          kind: "single",
          availability: availability(),
          favourite: false,
          favouriteBusy: false,
          height: 884,
          nodeIds: ["screen-node"],
          previewAction: "preview",
          reaction: null,
          title: "Task Manager Home",
          width: 390,
        }}
      />,
    );

    expect(screen.getByText("Task Manager Home")).not.toBeNull();
    expect(screen.getByText("390 x 884")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rename Task Manager Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(screen.getByRole("button", { name: "Modify" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(actions.onGenerate).toHaveBeenCalledOnce();
    expect(actions.onModify).toHaveBeenCalledOnce();
    expect(actions.onPreview).toHaveBeenCalledOnce();
    expect(actions.onRename).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Rename" })).not.toBeNull();
    expect(screen.getByRole("menuitemcheckbox", { name: "Favourite" })).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Like" })).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Dislike" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Version history" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Export" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Favourite" }));
    expect(actions.onToggleFavourite).toHaveBeenCalledOnce();
  });

  it("distinguishes prototype generation and preserves viewer read permissions", () => {
    render(
      <WorkbenchScreenContextToolbar
        {...handlers()}
        model={{
          kind: "single",
          availability: availability({
            canDelete: false,
            canDuplicate: false,
            canExport: false,
            canGenerate: false,
            canModify: false,
            canRename: false,
            canToggleFavourite: false,
          }),
          favourite: true,
          favouriteBusy: false,
          height: 844,
          nodeIds: ["screen-node"],
          previewAction: "generate",
          reaction: "like",
          title: "Static screen",
          width: 390,
        }}
      />,
    );

    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Modify" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Generate prototype" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((screen.getByRole("menuitemcheckbox", { name: "Unfavourite" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Version history" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders multi-selection commands and emits typed arrangement operations", () => {
    const actions = handlers();
    render(
      <WorkbenchScreenContextToolbar
        {...actions}
        model={{
          kind: "multiple",
          availability: availability(),
          count: 3,
          nodeIds: ["one", "two", "three"],
          previewAction: "generate",
        }}
      />,
    );

    expect(screen.getByText("3 selected")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Align" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Horizontal center" }));
    expect(actions.onAlign).toHaveBeenCalledWith({ kind: "align", alignment: "center" });

    fireEvent.click(screen.getByRole("button", { name: "Distribute" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Vertical spacing" }));
    expect(actions.onDistribute).toHaveBeenCalledWith({ kind: "distribute", axis: "vertical" });

    fireEvent.click(screen.getByRole("button", { name: "Generate variants" }));
    expect(actions.onGenerateVariants).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Generate prototype" }));
    expect(actions.onPreview).toHaveBeenCalledOnce();
  });

  it("exposes complete menu keyboard semantics and restores the trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchScreenContextToolbar
        {...handlers()}
        model={{
          kind: "single",
          availability: availability(),
          favourite: false,
          favouriteBusy: false,
          height: 844,
          nodeIds: ["screen-node"],
          previewAction: "preview",
          reaction: null,
          title: "Keyboard screen",
          width: 390,
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const menuId = trigger.getAttribute("aria-controls");
    expect(menuId).toBeTruthy();

    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "More" });
    expect(menu.id).toBe(menuId);
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Rename" }),
    ));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "More" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses checked menu roles for favourite and mutually exclusive reactions", async () => {
    const user = userEvent.setup();
    render(
      <WorkbenchScreenContextToolbar
        {...handlers()}
        model={{
          kind: "single",
          availability: availability(),
          favourite: true,
          favouriteBusy: false,
          height: 844,
          nodeIds: ["screen-node"],
          previewAction: "preview",
          reaction: "like",
          title: "Reaction screen",
          width: 390,
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Unfavourite" }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Like" }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Dislike" }).getAttribute("aria-checked"))
      .toBe("false");
    expect(screen.getByRole("menuitemradio", { name: "Like" }).hasAttribute("aria-pressed")).toBe(false);
  });

  it("keeps the toolbar and menus inside the available viewport bounds", () => {
    expect(calculateToolbarCollisionOffset(
      { bottom: 721, height: 71, left: -80, right: 286, top: 650, width: 366 },
      { bottom: 692, left: 12, right: 378, top: 12 },
    )).toEqual({ x: 92, y: -29 });

    expect(calculateContextMenuPlacement({
      align: "center",
      bounds: { bottom: 700, left: 12, right: 378, top: 12 },
      leftOffset: 0,
      menuHeight: 342,
      menuWidth: 224,
      toolbarRect: { bottom: 631, height: 71, left: 24, right: 390, top: 560, width: 366 },
    })).toMatchObject({
      left: 71,
      maxHeight: 542,
      side: "top",
    });
  });
});

function availability(
  overrides: Partial<WorkbenchScreenContextToolbarAvailability> = {},
): WorkbenchScreenContextToolbarAvailability {
  return {
    canAlign: true,
    canCopyLink: true,
    canDelete: true,
    canDistribute: true,
    canDuplicate: true,
    canExport: true,
    canGenerate: true,
    canGenerateVariants: true,
    canModify: true,
    canOpenVersions: true,
    canPreview: true,
    canRename: true,
    canToggleFavourite: true,
    canToggleReaction: true,
    ...overrides,
  };
}

function handlers(): Omit<WorkbenchScreenContextToolbarProps, "model"> {
  return {
    onAlign: vi.fn(),
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
    onDistribute: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onGenerate: vi.fn(),
    onGenerateVariants: vi.fn(),
    onModify: vi.fn(),
    onOpenVersions: vi.fn(),
    onPreview: vi.fn(),
    onRename: vi.fn(),
    onToggleFavourite: vi.fn(),
    onToggleDislike: vi.fn(),
    onToggleLike: vi.fn(),
  };
}

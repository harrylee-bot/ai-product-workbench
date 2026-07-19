// @vitest-environment jsdom

import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoardToolGestureLayer,
  RightToolRail,
  UtilityPill,
} from "./workbench-canvas-tools";

afterEach(cleanup);

describe("workbench canvas tools", () => {
  it("keeps read-only navigation tools available while disabling edit tools", () => {
    const onSelectTool = vi.fn();
    render(
      <RightToolRail
        activePanel={null}
        activeRun={false}
        activeTool="select"
        directEditAvailable={false}
        editable={false}
        onSelectTool={onSelectTool}
        onSelectMoreTool={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "Select" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Pan" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Marquee" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Direct edit" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Media" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Design system" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Favourites" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Pan" }));
    expect(onSelectTool).toHaveBeenCalledWith("pan");
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    expect((screen.getByRole("menuitem", { name: "Frame / Create" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("keeps Select and Pan available during an active Run", () => {
    render(
      <RightToolRail
        activePanel={null}
        activeRun
        activeTool="select"
        directEditAvailable={false}
        editable
        onSelectTool={vi.fn()}
        onSelectMoreTool={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: "Select" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Pan" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Marquee" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Direct edit" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Media" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("button", { name: "Design system" }) as HTMLButtonElement).disabled)
      .toBe(false);
    expect((screen.getByRole("button", { name: "Favourites" }) as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it("preserves undo, redo and exact zoom commands", () => {
    const onRedo = vi.fn();
    const onUndo = vi.fn();
    const onFitSelection = vi.fn();
    const onZoomTo = vi.fn();
    render(
      <UtilityPill
        canRedo
        canUndo={false}
        onFitSelection={onFitSelection}
        onRedo={onRedo}
        onResetView={vi.fn()}
        onToggleZoomMenu={vi.fn()}
        onUndo={onUndo}
        onZoomIn={vi.fn()}
        onZoomOut={vi.fn()}
        onZoomTo={onZoomTo}
        zoomLabel="63%"
        zoomMenuOpen
      />,
    );

    fireEvent.click(screen.getByTitle("Undo"));
    expect(onUndo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Redo"));
    expect(onRedo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom to 100%" }));
    expect(onZoomTo).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "57%" }));
    expect(onZoomTo).toHaveBeenCalledWith(0.57);
    expect(screen.getByRole("menuitem", { name: "63%" }).classList.contains("is-selected"))
      .toBe(true);
    fireEvent.click(screen.getByRole("menuitem", { name: "Zoom to Selection" }));
    expect(onFitSelection).toHaveBeenCalledOnce();
  });

  it("does not install a gesture capture layer for a non-drawing tool", () => {
    const { container } = render(
      <ReactFlowProvider>
        <BoardToolGestureLayer
          activeTool="select"
          enabled
          onCommitDrawing={vi.fn()}
          onCommitFrame={vi.fn()}
        />
      </ReactFlowProvider>,
    );

    expect(container.querySelector("[data-board-tool-gesture-layer]")).toBeNull();
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactContent: vi.fn(({ reference }: {
    reference: {
      artifactId: string;
      artifactVersionId: string;
      projectId: string;
      screenId?: string;
    };
  }) => (
    <div data-testid="real-artifact-content">
      {`${reference.artifactVersionId}:${reference.screenId ?? "document"}`}
    </div>
  )),
}));

vi.mock("@xyflow/react", () => ({
  NodeResizer: () => null,
}));

vi.mock("./workbench-artifact-content", () => ({
  WorkbenchArtifactContent: mocks.artifactContent,
}));

import { artboardNodeTypes } from "./workbench-board-nodes";

afterEach(() => {
  cleanup();
  mocks.artifactContent.mockClear();
});

describe("Workbench generated screen node", () => {
  it("renders the real Draft Artifact while refining instead of a fabricated skeleton", () => {
    const GeneratedScreen = artboardNodeTypes.generatedScreen;
    const reference = {
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype-draft",
      projectId: "project-real",
      screenId: "screen-checkout",
    };
    const props = {
      data: {
        artifact: reference,
        index: 0,
        phase: "refining",
        title: "结算页",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "run-draft:artifact-prototype:screen-checkout",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "generatedScreen",
      zIndex: 0,
    } satisfies ComponentProps<typeof GeneratedScreen>;

    const rendered = render(<GeneratedScreen {...props} />);

    expect(screen.getByTestId("real-artifact-content").textContent)
      .toBe("version-prototype-draft:screen-checkout");
    expect(mocks.artifactContent).toHaveBeenCalledOnce();
    expect(mocks.artifactContent.mock.calls[0]?.[0]).toEqual({ reference });
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]"))
      .toBeNull();
    expect(rendered.container.querySelector('[data-workbench-artifact-state="pending"]'))
      .toBeNull();
    expect(rendered.container.querySelector("[data-canvas-screen-node]")).toMatchObject({
      dataset: expect.objectContaining({
        canvasArtifactId: "artifact-prototype",
        canvasArtifactVersionId: "version-prototype-draft",
        canvasBoardNodeId: "run-draft:artifact-prototype:screen-checkout",
        canvasScreenId: "screen-checkout",
      }),
    });
  });

  it("suppresses a second screen-enter animation when a Draft becomes a persisted Board node", () => {
    const GeneratedScreen = artboardNodeTypes.generatedScreen;
    const rendered = render(<GeneratedScreen {...({
      data: {
        artifact: {
          artifactId: "artifact-prototype",
          artifactVersionId: "version-final",
          projectId: "project-real",
          screenId: "screen-checkout",
        },
        index: 0,
        phase: "complete",
        suppressEntrance: true,
        title: "结算页",
      },
      deletable: false,
      draggable: true,
      dragging: false,
      id: "board-node-final",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: true,
      selected: false,
      type: "generatedScreen",
      zIndex: 0,
    } satisfies ComponentProps<typeof GeneratedScreen>)} />);

    expect(rendered.container.querySelector("[data-workbench-generated-node]")
      ?.getAttribute("style")).toContain("animation: none");
  });
});

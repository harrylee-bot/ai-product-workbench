// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactContent: vi.fn(({ onArtifactTitleChange, onArtifactVersionStateChange, reference }: {
    onArtifactTitleChange?: (title: string) => void;
    onArtifactVersionStateChange?: (state: "error" | "pending" | "ready") => void;
    reference: {
      artifactId: string;
      artifactVersionId: string;
      projectId: string;
      screenId?: string;
    };
  }) => {
    const artifactVersionState = mocks.artifactVersionStates[reference.artifactVersionId]
      ?? mocks.artifactVersionState;
    useEffect(() => {
      onArtifactVersionStateChange?.(artifactVersionState);
    }, [artifactVersionState, onArtifactVersionStateChange]);
    useEffect(() => {
      if (artifactVersionState === "ready") {
        onArtifactTitleChange?.("签到打卡活动需求说明书");
      }
    }, [artifactVersionState, onArtifactTitleChange]);
    return (
      <div data-testid="real-artifact-content">
        {artifactVersionState === "error" ? (
          <>
            <span>Artifact unavailable</span>
            <button aria-label="重试加载产物" type="button" />
          </>
        ) : `${reference.artifactVersionId}:${reference.screenId ?? "document"}`}
      </div>
    );
  }),
  artifactVersionState: "ready" as "error" | "pending" | "ready",
  artifactVersionStates: {} as Record<string, "error" | "pending" | "ready">,
  nodeResizer: vi.fn((_props: Record<string, unknown>) => null),
}));

vi.mock("@xyflow/react", () => ({
  NodeResizer: mocks.nodeResizer,
}));

vi.mock("./workbench-artifact-content", () => ({
  WorkbenchArtifactContent: mocks.artifactContent,
}));

import { artboardNodeTypes } from "./workbench-board-nodes";

beforeEach(() => {
  mocks.artifactVersionState = "ready";
  mocks.artifactVersionStates = {};
});

afterEach(() => {
  cleanup();
  mocks.artifactContent.mockClear();
  mocks.nodeResizer.mockClear();
});

describe("Workbench generated screen node", () => {
  it("renders loading composition for a pending PRD node", () => {
    const DocumentCanvas = artboardNodeTypes.documentCanvas;
    const rendered = render(<DocumentCanvas {...({
      data: {
        phase: "generating",
        requestTitle: "创建会员中心 · 需求文档",
        title: "需求文档",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "run-pending:project-real:prd:document",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "documentCanvas",
      zIndex: 0,
    } satisfies ComponentProps<typeof DocumentCanvas>)} />);

    expect(screen.getByText("正在生成：创建会员中心 · 需求文档")).not.toBeNull();
    expect(rendered.container.querySelector('[data-workbench-artifact-state="pending"]'))
      .not.toBeNull();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]"))
      .not.toBeNull();
    expect(rendered.container.querySelector('[data-motion="document-wash"]'))
      .toBeNull();
    expect(rendered.container.querySelector(".workbench-artifact-spinner")).not.toBeNull();
    expect(rendered.container.querySelector(".animate-spin")).toBeNull();
    expect(mocks.artifactContent).not.toHaveBeenCalled();
    expect(mocks.nodeResizer.mock.calls.at(-1)?.[0]).toMatchObject({
      keepAspectRatio: true,
      minHeight: 500,
      minWidth: 500,
    });
  });

  it("uses a Prototype loading composition while the first generated screen is pending", () => {
    const GeneratedScreen = artboardNodeTypes.generatedScreen;
    const rendered = render(<GeneratedScreen {...({
      data: {
        index: 0,
        phase: "generating",
        requestTitle: "创建会员中心 · 界面 1",
        title: "界面草稿",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "run-pending:project-real:prototype:screen-1",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "generatedScreen",
      zIndex: 0,
    } satisfies ComponentProps<typeof GeneratedScreen>)} />);

    expect(screen.getByText("正在生成：创建会员中心 · 界面 1")).not.toBeNull();
    expect(rendered.container.querySelector(
      '[data-workbench-artifact-variant="prototype"]',
    )).not.toBeNull();
    expect(rendered.container.querySelector('[data-motion="generation-beam"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-motion="document-wash"]')).toBeNull();
  });

  it("preloads a real PRD Draft behind the reference loading copy until its query resolves", async () => {
    const DocumentCanvas = artboardNodeTypes.documentCanvas;
    const reference = {
      artifactId: "artifact-prd",
      artifactVersionId: "version-prd-draft",
      projectId: "project-real",
    };
    const props = {
      data: {
        artifact: reference,
        phase: "refining",
        title: "需求文档",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "run-draft:artifact-prd:document",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "documentCanvas",
      zIndex: 0,
    } satisfies ComponentProps<typeof DocumentCanvas>;
    mocks.artifactVersionState = "pending";
    const rendered = render(<DocumentCanvas {...props} />);

    expect(screen.getByText("正在细化：需求文档")).not.toBeNull();
    expect(screen.queryByText("Loading artifact...")).toBeNull();
    expect(mocks.artifactContent).toHaveBeenCalledOnce();
    expect(screen.getByTestId("real-artifact-content").parentElement?.getAttribute("aria-hidden"))
      .toBe("true");

    mocks.artifactVersionState = "ready";
    rendered.rerender(<DocumentCanvas {...props} />);
    await waitFor(() => {
      expect(screen.queryByText("正在细化：需求文档")).toBeNull();
    });
    expect(screen.getByText("签到打卡活动需求说明书")).not.toBeNull();
    expect(screen.getByTestId("real-artifact-content").textContent)
      .toBe("version-prd-draft:document");
    expect(screen.getByTestId("real-artifact-content").parentElement?.getAttribute("aria-hidden"))
      .toBe("false");
    expect(rendered.container.querySelector('[data-motion="document-wash"]')).toBeNull();
    expect(mocks.artifactContent.mock.calls.at(-1)?.[0]).toEqual({
      editable: false,
      editingBusy: false,
      onArtifactTitleChange: expect.any(Function),
      onArtifactVersionStateChange: expect.any(Function),
      onPrdDocumentCommit: expect.any(Function),
      pendingContent: null,
      reference,
    });
  });

  it("keeps the previous PRD readable while a refinement version resolves", async () => {
    const DocumentCanvas = artboardNodeTypes.documentCanvas;
    const previousArtifact = {
      artifactId: "artifact-prd",
      artifactVersionId: "version-prd-ready",
      projectId: "project-real",
    };
    const artifact = {
      ...previousArtifact,
      artifactVersionId: "version-prd-refining",
    };
    const props = {
      data: {
        artifact,
        phase: "refining",
        previousArtifact,
        title: "需求文档",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "board-node-prd",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "documentCanvas",
      zIndex: 0,
    } satisfies ComponentProps<typeof DocumentCanvas>;
    mocks.artifactVersionStates = {
      "version-prd-ready": "ready",
      "version-prd-refining": "pending",
    };
    const rendered = render(<DocumentCanvas {...props} />);

    expect(screen.getByText("version-prd-ready:document")).not.toBeNull();
    expect(screen.getByText("正在细化：需求文档")).not.toBeNull();
    expect(rendered.container.querySelector('[data-workbench-artifact-layer="incoming"]')
      ?.getAttribute("aria-hidden")).toBe("true");
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeNull();

    mocks.artifactVersionStates["version-prd-refining"] = "ready";
    rendered.rerender(<DocumentCanvas {...props} />);
    await waitFor(() => {
      expect(screen.queryByText("正在细化：需求文档")).toBeNull();
    });
    expect(screen.queryByText("version-prd-ready:document")).toBeNull();
    expect(screen.getByText("version-prd-refining:document")).not.toBeNull();
    expect(rendered.container.querySelector('[data-workbench-artifact-layer="incoming"]')
      ?.getAttribute("aria-hidden")).toBe("false");
  });

  it("preserves the previous PRD and exposes retry when the refinement query fails", async () => {
    const DocumentCanvas = artboardNodeTypes.documentCanvas;
    const props = {
      data: {
        artifact: {
          artifactId: "artifact-prd",
          artifactVersionId: "version-prd-refining",
          projectId: "project-real",
        },
        phase: "refining",
        previousArtifact: {
          artifactId: "artifact-prd",
          artifactVersionId: "version-prd-ready",
          projectId: "project-real",
        },
        title: "需求文档",
      },
      deletable: false,
      draggable: false,
      dragging: false,
      id: "board-node-prd",
      isConnectable: false,
      positionAbsoluteX: 0,
      positionAbsoluteY: 0,
      selectable: false,
      selected: false,
      type: "documentCanvas",
      zIndex: 0,
    } satisfies ComponentProps<typeof DocumentCanvas>;
    mocks.artifactVersionStates = {
      "version-prd-ready": "ready",
      "version-prd-refining": "error",
    };
    const rendered = render(<DocumentCanvas {...props} />);

    await waitFor(() => {
      expect(rendered.container.querySelector('[data-workbench-artifact-refresh-state="error"]'))
        .not.toBeNull();
    });
    expect(screen.getByText("version-prd-ready:document")).not.toBeNull();
    expect(screen.getByText("Artifact unavailable")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试加载产物" })).not.toBeNull();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeNull();

    mocks.artifactVersionStates["version-prd-refining"] = "pending";
    rendered.rerender(<DocumentCanvas {...props} />);
    await waitFor(() => {
      expect(rendered.container.querySelector('[data-workbench-artifact-refresh-state="pending"]'))
        .not.toBeNull();
    });
    expect(screen.getByText("version-prd-ready:document")).not.toBeNull();
    expect(screen.getByText("正在细化：需求文档")).not.toBeNull();
    expect(screen.queryByText("Artifact unavailable")).toBeNull();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeNull();

    mocks.artifactVersionStates["version-prd-refining"] = "ready";
    rendered.rerender(<DocumentCanvas {...props} />);
    await waitFor(() => {
      expect(rendered.container.querySelector("[data-workbench-artifact-refresh-state]"))
        .toBeNull();
    });
    expect(screen.queryByText("version-prd-ready:document")).toBeNull();
    expect(screen.getByText("version-prd-refining:document")).not.toBeNull();
  });

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

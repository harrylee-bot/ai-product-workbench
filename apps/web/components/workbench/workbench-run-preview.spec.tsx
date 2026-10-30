// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  boardNodeProtocol,
  type ArtifactVersionDetail,
} from "@workbench/workbench-contracts";
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import type { BoardFlowNode } from "@/lib/workbench/features/board";
import { prototypeEditorDocumentFixture } from "@/lib/workbench/prototype-editor/test-fixtures";
import type { RunArtifactDraftProjection } from "@/lib/workbench/run/reducer";

import { workbenchRunIsActive } from "@/lib/workbench/run";

import {
  boardNodesForPhase,
  createPrdVersionEditRequest,
  getPersistedPrdViewport,
  getPrdNodeViewport,
  mergeCanvasNodeSelection,
  observePersistedPrdNodes,
  projectReadyPrototypePreviewArtifacts,
  projectReadyPrdPreviewArtifacts,
  projectRunBoardNodes,
  runtimeDraftsToWorkbench,
  shouldAutoFitActivePrdViewport,
  workbenchAgentTaskSelectionBoundary,
} from "./workbench-project-route";
import { prdDocument } from "./workbench-prd-test-fixture";
import {
  MiniWorkbenchPreview,
  WorkbenchRunPreviewProvider,
  type WorkbenchRunPreviewContextValue,
} from "./workbench-run-preview";

afterEach(cleanup);

describe("PRD immutable version editing", () => {
  it("keeps legacy v1 and fixed-template v2 documents on their matching revision contracts", () => {
    const legacyDocument = prdDocument();

    expect(createPrdVersionEditRequest("version-v1", legacyDocument)).toEqual({
      kind: "prd",
      baseArtifactVersionId: "version-v1",
      document: legacyDocument,
    });
    expect(createPrdVersionEditRequest("version-v2", prdDocumentV2Example)).toEqual({
      kind: "prd",
      baseArtifactVersionId: "version-v2",
      document: prdDocumentV2Example,
    });
  });
});

describe("active PRD interaction boundaries", () => {
  it("resets a historical task selection when a same-prompt retry creates a new Run", () => {
    const firstRun = workbenchAgentTaskSelectionBoundary({
      projectMode: "document",
      prompt: "梳理业务规则",
      runId: "run-first",
    });
    const retryRun = workbenchAgentTaskSelectionBoundary({
      projectMode: "document",
      prompt: "梳理业务规则",
      runId: "run-retry",
    });

    expect(retryRun).not.toBe(firstRun);
    expect(workbenchAgentTaskSelectionBoundary({
      projectMode: "document",
      prompt: "梳理业务规则",
      runId: "run-first",
    })).toBe(firstRun);
  });

  it("stops active PRD auto-fit after the user adjusts that Run's viewport", () => {
    expect(shouldAutoFitActivePrdViewport({
      active: true,
      autoFitRunId: "run-prd",
      runId: "run-prd",
      userAdjustedRunId: null,
    })).toBe(true);
    expect(shouldAutoFitActivePrdViewport({
      active: true,
      autoFitRunId: "run-prd",
      runId: "run-prd",
      userAdjustedRunId: "run-prd",
    })).toBe(false);
    expect(shouldAutoFitActivePrdViewport({
      active: true,
      autoFitRunId: "run-prd",
      runId: "run-next",
      userAdjustedRunId: "run-prd",
    })).toBe(false);
  });
});

describe("Mini Workbench Run preview", () => {
  it("renders real project, prompt, activity, and message data without synthetic Run copy", async () => {
    const initial = previewValue({
      phase: "refining",
      projectTitle: "真实结算项目",
      prompt: "设计真实结算页",
      runActivities: [
        activity("activity-analysis", "分析真实支付需求", "succeeded"),
        activity("activity-prototype", "生成真实结算界面", "running"),
      ],
      runMessages: [message("message-draft", "已完成真实结算页草稿")],
      runPhaseLabel: "正在生成真实结算界面",
      runStatus: "running",
    });
    const { container, rerender } = renderPreview(initial);
    const previewRoot = container.firstElementChild;

    expect(screen.getByText("真实结算项目")).not.toBeNull();
    expect(screen.getByText("当前请求：设计真实结算页")).not.toBeNull();
    expect(screen.getByText("分析真实支付需求")).not.toBeNull();
    expect(screen.getAllByText("生成真实结算界面").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已完成真实结算页草稿").length).toBeGreaterThan(0);
    expect(screen.getByText("正在生成真实结算界面")).not.toBeNull();
    expect(screen.getByText("正在优化界面...")).not.toBeNull();
    expect(screen.getByText("3 条")).not.toBeNull();

    for (const fakeCopy of syntheticRunCopy) {
      expect(screen.queryByText(fakeCopy), fakeCopy).toBeNull();
    }

    const updated = previewValue({
      phase: "complete",
      projectTitle: "真实结算项目 v2",
      prompt: "发布真实结算页",
      runActivities: [activity("activity-publish", "发布真实结算产物", "succeeded")],
      runMessages: [message("message-published", "真实结算页已经发布")],
      runPhaseLabel: "产物发布完成",
      runStatus: "succeeded",
    });
    rerender(preview(updated));

    expect(container.firstElementChild).toBe(previewRoot);
    expect(screen.getByText("真实结算项目 v2")).not.toBeNull();
    expect(screen.getByText("当前请求：发布真实结算页")).not.toBeNull();
    expect(screen.getAllByText("发布真实结算产物").length).toBeGreaterThan(0);
    expect(screen.getAllByText("真实结算页已经发布").length).toBeGreaterThan(0);
    expect(screen.getByText("产物发布完成")).not.toBeNull();
    await waitFor(() => expect(screen.getByText("界面已生成")).not.toBeNull());
    expect(screen.getByText("2 条")).not.toBeNull();
  });

  it("uses neutral waiting copy when no Run activity or message exists", () => {
    renderPreview(previewValue());

    expect(screen.getByText("未命名项目")).not.toBeNull();
    expect(screen.getByText("等待运行")).not.toBeNull();
    expect(screen.getByText("等待记录")).not.toBeNull();
    expect(screen.getAllByText("等待运行活动").length).toBeGreaterThan(0);
    expect(screen.getByText("等待智能体消息")).not.toBeNull();
    expect(screen.getByText("等待运行内容")).not.toBeNull();
    for (const fakeCopy of syntheticRunCopy) {
      expect(screen.queryByText(fakeCopy), fakeCopy).toBeNull();
    }
  });

  it.each([
    { activityCount: 0, label: "0 records", messageCount: 0, waitingCount: 3 },
    { activityCount: 1, label: "1 record", messageCount: 0, waitingCount: 3 },
    { activityCount: 5, label: "4+ records", messageCount: 2, waitingCount: 0 },
  ])("keeps exactly four Run log rows for $label", ({ activityCount, messageCount, waitingCount }) => {
    renderPreview(previewValue({
      runActivities: Array.from({ length: activityCount }, (_, index) => (
        activity(`activity-${index + 1}`, `真实活动 ${index + 1}`, "succeeded")
      )),
      runMessages: Array.from({ length: messageCount }, (_, index) => (
        message(`message-${index + 1}`, `真实消息 ${index + 1}`)
      )),
    }));

    const header = screen.getByText("智能体日志 (Agent Log)");
    const rows = header.parentElement?.nextElementSibling;
    expect(rows?.children.length).toBe(4);
    expect(screen.queryAllByText("等待更多运行记录")).toHaveLength(waitingCount);
  });

  it.each([
    { mode: "board" as const, phase: "generating" as const },
    { mode: "document" as const, phase: "generating" as const },
    { mode: "generated" as const, phase: "refining" as const },
  ])("keeps the $mode canvas empty at $phase without a real Board or Draft", ({ mode, phase }) => {
    expect(boardNodesForPhase(phase, mode, 0.5, "真实支付工作流")).toEqual([]);
    expect(projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [],
      projectId: "project-real",
      runStatus: "running",
    })).toEqual([]);
  });

  it("never materializes transient presentation nodes for an idle or completed Run", () => {
    expect(boardNodesForPhase("idle", "board", 0, "真实支付工作流")).toEqual([]);
    expect(boardNodesForPhase("complete", "generated", 1, "真实支付工作流")).toEqual([]);
  });

  it("keeps Thinking free of fake PRD nodes and materializes only a real Draft or Board", () => {
    expect(projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [],
      projectId: "project-real",
      runStatus: "running",
    })).toEqual([]);

    const draft = draftProjection({
      artifactId: "artifact-prd",
      artifactVersionId: "version-prd-draft",
      kind: "prd",
    });
    expect(projectRunBoardNodes({
      drafts: [draft],
      persistedBoardNodes: [],
      projectId: "project-real",
      runStatus: "running",
    }).map((node) => node.id)).toEqual([]);

    expect(projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [persistedPrdNode({
        id: "board-node-prd",
        position: { x: 0, y: 0 },
      })],
      projectId: "project-real",
      runStatus: "running",
    }).map((node) => node.id)).toEqual(["board-node-prd"]);

    expect(projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [],
      projectId: "project-real",
      runStatus: "succeeded",
    })).toEqual([]);
  });

  it("targets only the first empty-to-persisted PRD transition", () => {
    const prd = persistedPrdNode({
      id: "board-node-prd",
      position: { x: 0, y: 0 },
    });
    const prototype = persistedPrototypeNode({
      artifactId: "artifact-prototype",
      artifactVersionId: "version-prototype",
      id: "board-node-prototype",
      position: { x: 0, y: 0 },
      screenId: "screen-main",
    });

    const initial = observePersistedPrdNodes(null, []);
    expect(initial.target).toBeNull();
    const withoutPrd = observePersistedPrdNodes(initial.nodeIds, [prototype]);
    expect(withoutPrd.target).toBeNull();
    const published = observePersistedPrdNodes(withoutPrd.nodeIds, [prototype, prd]);
    expect(published.target?.id).toBe("board-node-prd");
    expect(observePersistedPrdNodes(published.nodeIds, [prototype, prd]).target).toBeNull();
    expect(observePersistedPrdNodes(null, [prd]).target).toBeNull();
    expect(observePersistedPrdNodes(null, [prd], "board-node-prd").target?.id)
      .toBe("board-node-prd");
  });

  it("preserves a persisted PRD size and anchors it beyond the inspector", () => {
    const prd = persistedPrdNode({
      id: "board-node-prd",
      position: { x: 600, y: 400 },
    });
    const [normalized] = projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [prd],
      projectId: "project-real",
      runStatus: null,
    });
    const viewport = getPersistedPrdViewport(prd, 1440, 900);
    const projectedLeft = viewport.x + prd.position.x * viewport.zoom;
    const projectedTop = viewport.y + prd.position.y * viewport.zoom;
    const projectedRight = projectedLeft + prd.workbench.size!.width * viewport.zoom;

    expect(normalized).toMatchObject({
      height: 3001,
      style: { height: 3001, width: 1154 },
      width: 1154,
    });
    expect(projectedLeft).toBeGreaterThanOrEqual(320);
    expect(projectedTop).toBeCloseTo(92, 5);
    expect(projectedRight).toBeLessThanOrEqual(1400);
    expect(viewport.zoom).toBeCloseTo((563 / 1154) * 0.88, 5);
    expect(projectedTop + prd.workbench.size!.height * viewport.zoom).toBeGreaterThan(900);
  });

  it.each([
    { containerHeight: 812, containerWidth: 375, expectedLeft: 24, expectedTop: 186, rightInset: 40 },
    { containerHeight: 1024, containerWidth: 768, expectedLeft: 320, expectedTop: 92, rightInset: 80 },
  ])(
    "keeps an active PRD inside a $containerWidth px viewport after resize",
    ({ containerHeight, containerWidth, expectedLeft, expectedTop, rightInset }) => {
      const prd = persistedPrdNode({
        id: "board-node-prd-responsive",
        position: { x: 600, y: 400 },
      });
      const viewport = getPersistedPrdViewport(prd, containerWidth, containerHeight);
      const projectedLeft = viewport.x + prd.position.x * viewport.zoom;
      const projectedTop = viewport.y + prd.position.y * viewport.zoom;
      const projectedRight = projectedLeft + prd.workbench.size!.width * viewport.zoom;

      expect(projectedLeft).toBeCloseTo(expectedLeft, 5);
      expect(projectedTop).toBeCloseTo(expectedTop, 5);
      expect(projectedRight).toBeLessThanOrEqual(containerWidth - rightInset);
      if (containerWidth < 768) {
        const projectedBottom = projectedTop + prd.workbench.size!.height * viewport.zoom;
        expect(projectedBottom).toBeLessThanOrEqual(containerHeight - 222 - 54 - 16);
      }
    },
  );

  it.each([
    { containerHeight: 812, containerWidth: 375 },
    { containerHeight: 720, containerWidth: 320 },
  ])("fits the A4 draft above the mobile tools at $containerWidth x $containerHeight", ({ containerHeight, containerWidth }) => {
    const persisted = persistedPrdNode({ id: "a4-draft", position: { x: 600, y: 400 } });
    const draft = {
      ...persisted,
      workbench: { ...persisted.workbench, size: { width: 500, height: 707 } },
    } satisfies BoardFlowNode;
    const viewport = getPersistedPrdViewport(draft, containerWidth, containerHeight);
    const top = viewport.y + draft.position.y * viewport.zoom;
    const left = viewport.x + draft.position.x * viewport.zoom;

    expect(top).toBeCloseTo(186, 5);
    expect(left).toBeCloseTo(24, 5);
    expect(left + 500 * viewport.zoom).toBeLessThanOrEqual(containerWidth - 40);
    expect(top + 707 * viewport.zoom).toBeCloseTo(containerHeight - 292, 5);
  });

  it.each([
    { containerWidth: 1440, containerHeight: 900, composerTop: 788 },
    { containerWidth: 1501, containerHeight: 855, composerTop: 743 },
  ])("keeps a loading document above the Composer at $containerWidth x $containerHeight", ({ containerWidth, containerHeight, composerTop }) => {
    const position = { x: 600, y: 400 };
    const viewport = getPrdNodeViewport(position, 500, 707, containerWidth, containerHeight, composerTop - 16);
    const top = viewport.y + position.y * viewport.zoom;

    expect(top).toBeCloseTo(92, 5);
    expect(top + 707 * viewport.zoom).toBeCloseTo(composerTop - 16, 5);
  });

  it("renders a persisted 500px PRD at the source-measured 563px width at 93%", () => {
    const persisted = persistedPrdNode({
      id: "board-node-prd-square",
      position: { x: 0, y: 0 },
    });
    const square = {
      ...persisted,
      style: { height: 500, width: 500 },
      workbench: {
        ...persisted.workbench,
        size: { height: 500, width: 500 },
      },
    } satisfies BoardFlowNode;
    const viewport = getPersistedPrdViewport(square, 1501, 855);

    expect(viewport.zoom).toBeCloseTo(563 / 500, 5);
    expect(square.workbench.size!.width * viewport.zoom).toBeCloseTo(563, 5);
  });

  it("does not import ephemeral interaction overrides from the Board store", () => {
    const persisted = {
      ...persistedPrototypeNode({
        artifactId: "artifact-prototype",
        artifactVersionId: "version-prototype",
        id: "board-node-selected",
        position: { x: 120, y: 80 },
        screenId: "screen-home",
      }),
      selected: true,
    };

    const [projected] = projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [persisted],
      projectId: "project-real",
      runStatus: "succeeded",
    });

    expect(persisted.selected).toBe(true);
    expect(projected?.selected).toBe(false);
    expect(projected).not.toHaveProperty("draggable");
  });

  it("merges surviving local multi-selection across a persisted Board refresh", () => {
    const first = persistedPrototypeNode({
      artifactId: "artifact-first",
      artifactVersionId: "version-first",
      id: "board-node-first",
      position: { x: 120, y: 80 },
      screenId: "screen-first",
    });
    const second = persistedPrototypeNode({
      artifactId: "artifact-second",
      artifactVersionId: "version-second",
      id: "board-node-second",
      position: { x: 560, y: 80 },
      screenId: "screen-second",
    });
    const refreshed = projectRunBoardNodes({
      drafts: [],
      persistedBoardNodes: [first, second],
      projectId: "project-real",
      runStatus: "succeeded",
    });
    const merged = mergeCanvasNodeSelection(
      refreshed,
      [
        { ...refreshed[0]!, selected: true },
        { ...refreshed[1]!, selected: true },
        { ...refreshed[1]!, id: "board-node-deleted", selected: true },
      ],
      "",
    );

    expect(merged.filter((node) => node.selected).map((node) => node.id))
      .toEqual(["board-node-first", "board-node-second"]);
    expect(mergeCanvasNodeSelection(refreshed, [], "board-node-second")
      .filter((node) => node.selected).map((node) => node.id))
      .toEqual(["board-node-second"]);
    expect(mergeCanvasNodeSelection(
      refreshed,
      [{ ...refreshed[0]!, selected: true }, refreshed[1]!],
      "board-node-second",
    ).filter((node) => node.selected).map((node) => node.id))
      .toEqual(["board-node-second"]);
  });

  it("projects exactly one immutable generated node per real prototype Draft screen", () => {
    const nodes = runtimeDraftsToWorkbench([
      draftProjection({
        artifactId: "artifact-prototype",
        artifactVersionId: "version-prototype-draft",
        kind: "prototype",
        screens: [
          {
            id: "screen-checkout",
            name: "结算页",
            route: "/checkout",
            checksum: "c".repeat(64),
            revision: 0,
            viewport: { height: 844, width: 390 },
          },
          {
            id: "screen-success",
            name: "支付成功页",
            route: "/checkout/success",
            checksum: "d".repeat(64),
            revision: 0,
            viewport: { height: 900, width: 1440 },
          },
        ],
      }),
    ], "project-real");

    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => {
      if (node.type !== "generatedScreen") {
        throw new Error(`Expected a generated screen, received ${node.type}`);
      }
      return {
        artifact: node.data.artifact,
        draggable: node.draggable,
        id: node.id,
        selectable: node.selectable,
      selected: node.selected,
      position: node.position,
      style: node.style,
        title: node.data.title,
        type: node.type,
      };
    })).toEqual([
      {
        artifact: {
          artifactId: "artifact-prototype",
          artifactVersionId: "version-prototype-draft",
          projectId: "project-real",
          screenId: "screen-checkout",
        },
        draggable: false,
        id: "run-draft:artifact-prototype:screen-checkout",
        position: { x: 0, y: 0 },
        selectable: false,
        selected: false,
        style: { height: 844, width: 390 },
        title: "结算页",
        type: "generatedScreen",
      },
      {
        artifact: {
          artifactId: "artifact-prototype",
          artifactVersionId: "version-prototype-draft",
          projectId: "project-real",
          screenId: "screen-success",
        },
        draggable: false,
        id: "run-draft:artifact-prototype:screen-success",
        position: { x: 470, y: 0 },
        selectable: false,
        selected: false,
        style: { height: 900, width: 1440 },
        title: "支付成功页",
        type: "generatedScreen",
      },
    ]);
    expect(nodes[0]!.position.x + Number(nodes[0]!.style?.width))
      .toBeLessThan(nodes[1]!.position.x);
  });

  it("exposes only authorized ready interactive Prototype screens to Preview", () => {
    const runnable = prototypeVersion("artifact-runnable", "version-runnable", true);
    const staticVersion = prototypeVersion("artifact-static", "version-static", false);
    const targets = [
      previewTarget("node-runnable", runnable.artifactId, runnable.artifactVersionId),
      previewTarget("node-static", staticVersion.artifactId, staticVersion.artifactVersionId),
      previewTarget("node-unavailable", "artifact-unavailable", "version-unavailable"),
    ];

    expect(projectReadyPrototypePreviewArtifacts(targets, [runnable, staticVersion])).toEqual([{
      reference: targets[0]!.reference,
      title: "node-runnable",
    }]);
  });

  it("projects one immutable document node for a real PRD Draft", () => {
    const nodes = runtimeDraftsToWorkbench([
      draftProjection({
        artifactId: "artifact-prd",
        artifactVersionId: "version-prd-draft",
        kind: "prd",
      }),
    ], "project-real");

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      data: {
        artifact: {
          artifactId: "artifact-prd",
          artifactVersionId: "version-prd-draft",
          projectId: "project-real",
        },
        phase: "refining",
        title: "需求文档",
      },
      draggable: false,
      id: "run-draft:artifact-prd:document",
      position: { x: 0, y: 0 },
      selectable: false,
      selected: false,
      style: { height: 1123, width: 794 },
      type: "documentCanvas",
    });
  });

  it("exposes a persisted complete PRD as a document Preview target", () => {
    const reference = {
      artifactId: "artifact-prd",
      artifactVersionId: "version-prd-ready",
      projectId: "project-real",
    };
    const nodes = [{
      data: { artifact: reference, phase: "complete" as const, title: "订单通知需求说明书" },
      id: "node-prd",
      position: { x: 0, y: 0 },
      type: "documentCanvas" as const,
    }];

    expect(projectReadyPrdPreviewArtifacts(nodes, new Set(["node-prd"]))).toEqual([{
      kind: "prd",
      reference,
      title: "订单通知需求说明书",
    }]);
    expect(projectReadyPrdPreviewArtifacts(nodes, new Set())).toEqual([]);
  });

  it("projects no Board nodes before a real Artifact Draft exists", () => {
    expect(runtimeDraftsToWorkbench([], "project-real")).toEqual([]);
  });

  it("keeps the persisted prototype unchanged while the edit Draft is in the dock", () => {
    const persisted = persistedPrototypeNode({
      artifactId: "artifact-prototype",
      artifactVersionId: "version-before-edit",
      id: "board-node-checkout",
      position: { x: 320, y: 180 },
      screenId: "screen-checkout",
    });
    const nodes = projectRunBoardNodes({
      drafts: [draftProjection({
        artifactId: "artifact-prototype",
        artifactVersionId: "version-edit-draft",
        kind: "prototype",
        screens: [{
          id: "screen-checkout",
          name: "结算页 v2",
          route: "/checkout",
          checksum: "c".repeat(64),
          revision: 0,
          viewport: { height: 900, width: 1440 },
        }],
      })],
      persistedBoardNodes: [persisted],
      projectId: "project-real",
      runStatus: "running",
    });

    expect(nodes).toEqual(projectRunBoardNodes({ drafts: [], persistedBoardNodes: [persisted], projectId: "project-real", runStatus: "running" }));
  });

  it("keeps the persisted PRD while its edit Draft is in the dock", () => {
    const persisted = persistedPrdNode({ artifactId: "artifact-prd", artifactVersionId: "version-before-edit", id: "board-node-prd", position: { x: 160, y: 120 } });
    const nodes = projectRunBoardNodes({ drafts: [draftProjection({ artifactId: "artifact-prd", artifactVersionId: "version-edit-draft", kind: "prd" })], persistedBoardNodes: [persisted], projectId: "project-real", runStatus: "running" });
    expect(nodes).toEqual(projectRunBoardNodes({ drafts: [], persistedBoardNodes: [persisted], projectId: "project-real", runStatus: "running" }));
  });

  it("promotes a completed Draft until the final Board arrives, then suppresses duplicate entrance", () => {
    const draft = draftProjection({
      artifactId: "artifact-prototype",
      artifactVersionId: "version-final",
      kind: "prototype",
      screens: [{
        id: "screen-checkout",
        name: "结算页",
        route: "/checkout",
        checksum: "c".repeat(64),
        revision: 0,
        viewport: { height: 900, width: 1440 },
      }],
    });
    const completing = projectRunBoardNodes({
      drafts: [draft],
      persistedBoardNodes: [],
      projectId: "project-real",
      runStatus: "succeeded",
    });

    expect(completing).toHaveLength(1);
    expect(completing[0]).toMatchObject({
      data: { phase: "complete" },
      id: "run-draft:artifact-prototype:screen-checkout",
      position: { x: 0, y: 0 },
    });

    const published = projectRunBoardNodes({
      drafts: [draft],
      persistedBoardNodes: [persistedPrototypeNode({
        artifactId: "artifact-prototype",
        artifactVersionId: "version-final",
        id: "board-node-final",
        position: { x: 0, y: 0 },
        screenId: "screen-checkout",
      })],
      projectId: "project-real",
      runStatus: "succeeded",
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      data: {
        artifact: { artifactVersionId: "version-final" },
        phase: "complete",
        suppressEntrance: true,
      },
      id: "board-node-final",
      position: { x: 0, y: 0 },
    });
  });

  it.each(["failed", "cancelled"] as const)(
    "never renders a stale Draft after a Run is %s",
    (runStatus) => {
      expect(projectRunBoardNodes({
        drafts: [draftProjection({
          screens: [{
            id: "screen-stale",
            name: "失效草稿",
            route: "/stale",
            checksum: "c".repeat(64),
            revision: 0,
            viewport: { height: 844, width: 390 },
          }],
        })],
        persistedBoardNodes: [],
        projectId: "project-real",
        runStatus,
      })).toEqual([]);
    },
  );

  it("treats only non-terminal Run states as active generation", () => {
    expect(["queued", "running", "waiting_input", "cancelling"].every((status) => (
      workbenchRunIsActive(status as Parameters<typeof workbenchRunIsActive>[0])
    ))).toBe(true);
    expect([null, "succeeded", "failed", "cancelled"].every((status) => (
      !workbenchRunIsActive(status as Parameters<typeof workbenchRunIsActive>[0])
    ))).toBe(true);
  });
});

const syntheticRunCopy = [
  "产品工作台示例项目",
  "Assistant Active",
  "Initialize grid syst...",
  "Generate color tokens",
  "Synthesizing layout...",
  "Apply shader effects",
  "14:42:11",
  "14:42:15",
  "view_quilt Debug_Frame_v2: Frame",
  "Make it darker",
  "Add a hero",
  "Bento layout",
] as const;

function renderPreview(value: WorkbenchRunPreviewContextValue) {
  return render(preview(value));
}

function preview(value: WorkbenchRunPreviewContextValue) {
  return (
    <WorkbenchRunPreviewProvider {...value}>
      <MiniWorkbenchPreview phase="idle" />
    </WorkbenchRunPreviewProvider>
  );
}

function previewValue(
  overrides: Partial<WorkbenchRunPreviewContextValue> = {},
): WorkbenchRunPreviewContextValue {
  return {
    phase: "idle",
    projectTitle: "",
    prompt: "",
    runActivities: [],
    runMessages: [],
    runPhaseLabel: null,
    runStatus: null,
    ...overrides,
  };
}

function activity(
  id: string,
  label: string,
  status: WorkbenchRunPreviewContextValue["runActivities"][number]["status"],
): WorkbenchRunPreviewContextValue["runActivities"][number] {
  const working = status === "pending" || status === "running";
  return {
    detail: null,
    id,
    label,
    status,
    terminal: !working,
    working,
  };
}

function message(
  id: string,
  text: string,
): WorkbenchRunPreviewContextValue["runMessages"][number] {
  return {
    id,
    status: "completed",
    text,
    working: false,
  };
}

function draftProjection(
  overrides: Partial<RunArtifactDraftProjection> = {},
): RunArtifactDraftProjection {
  return {
    artifactId: "artifact-draft",
    artifactIndex: 0,
    artifactVersionId: "version-draft",
    attempt: 1,
    checksum: "a".repeat(64),
    draftChecksum: "b".repeat(64),
    kind: "prototype",
    screens: [],
    ...overrides,
  };
}

function persistedPrototypeNode({
  artifactId,
  artifactVersionId,
  id,
  position,
  screenId,
}: {
  artifactId: string;
  artifactVersionId: string;
  id: string;
  position: { x: number; y: number };
  screenId: string;
}): BoardFlowNode {
  return {
    data: {
      artifactKind: "prototype",
      nodeType: "artifact",
      protocol: boardNodeProtocol,
      route: `/${screenId}`,
      screenId,
      title: "Persisted screen",
    },
    id,
    position,
    style: { height: 844, width: 390 },
    type: "artifact",
    workbench: {
      artifactId,
      artifactVersionId,
      kind: "artifact",
      order: 0,
      size: { height: 844, width: 390 },
    },
  };
}

function persistedPrdNode({
  artifactId = "artifact-prd",
  artifactVersionId = "version-prd",
  id,
  position,
}: {
  artifactId?: string;
  artifactVersionId?: string;
  id: string;
  position: { x: number; y: number };
}): BoardFlowNode {
  return {
    data: {
      artifactKind: "prd",
      nodeType: "artifact",
      protocol: boardNodeProtocol,
      title: "Persisted PRD",
    },
    id,
    position,
    style: { height: 3001, width: 1154 },
    type: "artifact",
    workbench: {
      artifactId,
      artifactVersionId,
      kind: "artifact",
      order: 0,
      size: { height: 3001, width: 1154 },
    },
  };
}

function previewTarget(nodeId: string, artifactId: string, artifactVersionId: string) {
  return {
    nodeId,
    reference: {
      artifactId,
      artifactVersionId,
      projectId: "project-real",
      screenId: "screen-main",
    },
    title: nodeId,
  };
}

function prototypeVersion(
  artifactId: string,
  artifactVersionId: string,
  interactive: boolean,
): ArtifactVersionDetail {
  const document = prototypeEditorDocumentFixture();
  if (interactive) {
    const root = document.nodes.find((node) => node.id === "node-root")!;
    root.actionIds = ["action-open"];
    document.actions = [{
      id: "action-open",
      nodeId: root.id,
      event: "click",
      kind: "openUrl",
      target: "newWindow",
      url: "https://example.com/preview",
    }];
  }
  return {
    artifactId,
    artifactVersionId,
    version: 1,
    status: "ready",
    checksum: "a".repeat(64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    contentMode: "inline",
    kind: "prototype",
    schemaVersion: 1,
    content: document,
  };
}

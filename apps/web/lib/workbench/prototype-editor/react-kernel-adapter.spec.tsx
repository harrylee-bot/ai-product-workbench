// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PrototypeEditorKernelAdapter,
  rotateSnapshot,
  setRotateStart,
} from "./react-kernel-adapter";
import { prototypeEditorDocumentFixture } from "./test-fixtures";

afterEach(() => cleanup());

describe("PrototypeEditorKernelAdapter", () => {
  it("mounts and unmounts Selecto and Moveable on React 19", () => {
    const selectionHost = window.document.createElement("div");
    window.document.body.append(selectionHost);
    const view = render(
      <PrototypeEditorKernelAdapter
        container={selectionHost}
        document={prototypeEditorDocumentFixture()}
        onSelectionChange={vi.fn()}
        onTransformCommit={vi.fn()}
        onTransformPreview={vi.fn()}
        rendererTransform={{ translateX: 0, translateY: 0, zoom: 1 }}
        resolveTarget={() => null}
        screenId="screen-main"
        selectedNodeIds={[]}
      />,
    );

    expect(view.container).toBeTruthy();
    expect(() => view.unmount()).not.toThrow();
    selectionHost.remove();
  });

  it("seeds Moveable from the IR angle and snapshots its final local absolute angle", () => {
    const document = prototypeEditorDocumentFixture();
    document.nodes[1].style.rotation = 35;
    const target = window.document.createElement("div");
    target.setAttribute("data-prototype-node-id", "node-card");
    const set = vi.fn();
    const stopAble = vi.fn();

    setRotateStart(document, "screen-main", { target, set, stopAble });
    expect(set).toHaveBeenCalledWith(35);
    expect(stopAble).not.toHaveBeenCalled();
    expect(rotateSnapshot("screen-main", {
      target,
      rotation: 82.5,
    })).toEqual({
      kind: "rotate",
      nodeId: "node-card",
      screenId: "screen-main",
      degrees: 82.5,
      position: null,
    });
  });

  it("stops a rotate gesture whose DOM target is not in the current screen", () => {
    const target = window.document.createElement("div");
    target.setAttribute("data-prototype-node-id", "node-missing");
    const set = vi.fn();
    const stopAble = vi.fn();
    setRotateStart(prototypeEditorDocumentFixture(), "screen-main", { target, set, stopAble });
    expect(stopAble).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();
  });
});

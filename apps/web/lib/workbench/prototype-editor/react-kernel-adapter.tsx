"use client";

import type { PrototypeDocument } from "@workbench/workbench-contracts";
import { useEffect, useRef } from "react";
import Moveable, {
  type OnDrag,
  type OnDragGroup,
  type OnResize,
  type OnResizeGroup,
  type OnRotate,
  type OnRotateGroup,
  type OnRotateGroupStart,
  type OnRotateStart,
} from "react-moveable";
import Selecto, { type OnSelectEnd } from "react-selecto";

import {
  PROTOTYPE_SELECTABLE_TARGET,
  createPrototypeGroupRotationBaseline,
  createPrototypeTransformGestureBuffer,
  groupRotationSnapshots,
  prototypeNodeIdFromDomTarget,
  rendererPointToDocument,
  rendererSizeToDocument,
  selectionFromDomTargets,
  selectionFromNodeIds,
  type PrototypeEditorResult,
  type PrototypeGroupRotationBaseline,
  type PrototypeRendererTransform,
  type PrototypeSelection,
  type PrototypeTransformBatchCommand,
  type PrototypeTransformGestureBuffer,
  type PrototypeTransformSnapshot,
} from "./model";

export interface PrototypeEditorKernelAdapterProps {
  container: HTMLElement | null;
  document: PrototypeDocument;
  rendererTransform: PrototypeRendererTransform;
  screenId: string;
  selectedNodeIds: readonly string[];
  resolveTarget(nodeId: string): HTMLElement | SVGElement | null;
  onSelectionChange(selection: PrototypeSelection): void;
  onTransformPreview(result: PrototypeEditorResult<PrototypeTransformBatchCommand>): void;
  onTransformCommit(result: PrototypeEditorResult<PrototypeTransformBatchCommand>): void;
}

// Keep Moveable/Selecto isolated here so the product renderer owns only Workbench IR and commands.
export function PrototypeEditorKernelAdapter({
  container,
  document,
  rendererTransform,
  screenId,
  selectedNodeIds,
  resolveTarget,
  onSelectionChange,
  onTransformPreview,
  onTransformCommit,
}: PrototypeEditorKernelAdapterProps) {
  const selection = selectionFromNodeIds(document, screenId, selectedNodeIds);
  const targets = selection.nodeIds
    .map(resolveTarget)
    .filter((target): target is HTMLElement | SVGElement => target !== null);
  const gestureRef = useRef<PrototypeTransformGestureBuffer | null>(null);
  const groupRotationRef = useRef<PrototypeGroupRotationBaseline | null>(null);
  if (!gestureRef.current) gestureRef.current = createPrototypeTransformGestureBuffer();
  const selectionKey = selection.nodeIds.join("\0");
  useEffect(() => {
    gestureRef.current?.cancel();
    groupRotationRef.current = null;
  }, [screenId, selectionKey]);
  const preview = (snapshots: readonly PrototypeTransformSnapshot[]) => {
    onTransformPreview(gestureRef.current!.preview(snapshots));
  };
  const commit = () => {
    const result = gestureRef.current!.commit();
    if (result) onTransformCommit(result);
  };
  const rotateGroupStart = (event: OnRotateGroupStart) => {
    for (const item of event.events) setRotateStart(document, screenId, item);
    const baseline = createPrototypeGroupRotationBaseline(document, screenId, selection.nodeIds);
    if (!baseline.ok) {
      event.stopAble();
      onTransformPreview(baseline);
      return;
    }
    groupRotationRef.current = baseline.value;
  };
  const rotateGroup = (event: OnRotateGroup) => {
    const baseline = groupRotationRef.current;
    if (!baseline) {
      onTransformPreview({ ok: false, code: "empty_transform_batch", nodeId: "" });
      return;
    }
    const snapshots = groupRotationSnapshots(baseline, event.beforeDist);
    if (!snapshots.ok) {
      onTransformPreview(snapshots);
      return;
    }
    preview(snapshots.value);
  };
  const commitGroup = () => {
    commit();
    groupRotationRef.current = null;
  };
  const select = (event: OnSelectEnd) => {
    onSelectionChange(selectionFromDomTargets(document, screenId, event.selected));
  };

  return (
    <>
      <Selecto
        container={container}
        dragContainer={container}
        hitRate={0}
        onSelectEnd={select}
        selectableTargets={[PROTOTYPE_SELECTABLE_TARGET]}
        selectByClick
        selectFromInside={false}
      />
      <Moveable
        draggable
        onDrag={(event) => preview([moveSnapshot(screenId, rendererTransform, event)])}
        onDragEnd={commit}
        onDragGroup={(event) => preview(event.events.map((item) => moveSnapshot(screenId, rendererTransform, item)))}
        onDragGroupEnd={commit}
        onResize={(event) => preview([resizeSnapshot(screenId, rendererTransform, event)])}
        onResizeEnd={commit}
        onResizeGroup={(event) => preview(event.events.map((item) => resizeSnapshot(screenId, rendererTransform, item)))}
        onResizeGroupEnd={commit}
        onRotateStart={(event) => setRotateStart(document, screenId, event)}
        onRotate={(event) => preview([rotateSnapshot(screenId, event)])}
        onRotateEnd={commit}
        onRotateGroupStart={rotateGroupStart}
        onRotateGroup={rotateGroup}
        onRotateGroupEnd={commitGroup}
        origin={false}
        resizable
        rotatable
        target={targets.length === 1 ? targets[0] : targets}
      />
    </>
  );
}

function moveSnapshot(
  screenId: string,
  transform: PrototypeRendererTransform,
  event: OnDrag | OnDragGroup,
): PrototypeTransformSnapshot {
  const point = rendererPointToDocument({ x: event.left, y: event.top }, transform);
  return {
    kind: "move",
    nodeId: eventNodeId(event.target),
    screenId,
    x: point.x,
    y: point.y,
  };
}

function resizeSnapshot(
  screenId: string,
  transform: PrototypeRendererTransform,
  event: OnResize | OnResizeGroup,
): PrototypeTransformSnapshot {
  const point = rendererPointToDocument({ x: event.drag.left, y: event.drag.top }, transform);
  const size = rendererSizeToDocument({ width: event.width, height: event.height }, transform);
  return {
    kind: "resize",
    nodeId: eventNodeId(event.target),
    screenId,
    x: point.x,
    y: point.y,
    width: size.width,
    height: size.height,
  };
}

export function rotateSnapshot(
  screenId: string,
  event: Pick<OnRotate, "rotation" | "target">,
): PrototypeTransformSnapshot {
  return {
    kind: "rotate",
    nodeId: eventNodeId(event.target),
    screenId,
    degrees: event.rotation,
    position: null,
  };
}

export function setRotateStart(
  document: PrototypeDocument,
  screenId: string,
  event: Pick<OnRotateStart, "set" | "stopAble" | "target">,
): void {
  const nodeId = eventNodeId(event.target);
  const node = document.nodes.find((candidate) => candidate.id === nodeId && candidate.screenId === screenId);
  if (!node) {
    event.stopAble();
    return;
  }
  event.set(node.style.rotation);
}

function eventNodeId(target: HTMLElement | SVGElement): string {
  return prototypeNodeIdFromDomTarget(target) ?? "";
}

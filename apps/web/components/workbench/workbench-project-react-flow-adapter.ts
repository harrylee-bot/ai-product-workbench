"use client";

import {
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";

import type {
  BoardEdgeChangeReducer,
  BoardNodeChangeReducer,
} from "@/lib/workbench/features/board";

export const reduceWorkbenchProjectNodeChanges: BoardNodeChangeReducer = (
  changes,
  nodes,
) => applyNodeChanges(changes, nodes);

export const reduceWorkbenchProjectEdgeChanges: BoardEdgeChangeReducer = (
  changes,
  edges,
) => applyEdgeChanges(changes, edges);

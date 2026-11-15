"use client";

import {
  applyNodeChanges,
} from "@xyflow/react";

import type {
  BoardNodeChangeReducer,
} from "@/lib/workbench/features/board";

export const reduceWorkbenchProjectNodeChanges: BoardNodeChangeReducer = (
  changes,
  nodes,
) => applyNodeChanges(changes, nodes);

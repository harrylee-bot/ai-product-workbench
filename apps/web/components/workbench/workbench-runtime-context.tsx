"use client";

import { createContext, useContext } from "react";

import type { WorkbenchUser } from "@/lib/auth/workbench-auth";
import type {
  CanvasInteractionMode,
  CanvasPanel,
} from "@/lib/workbench/canvas-tools";
import type {
  useWorkbenchController,
} from "@/lib/workbench/features/workbench-controller";

export type WorkbenchRouteView = "home" | "project";

type WorkbenchController = ReturnType<typeof useWorkbenchController>;

export type WorkbenchRuntimeContextValue = {
  activePanel: CanvasPanel;
  activeTool: CanvasInteractionMode;
  closeProject: () => Promise<boolean>;
  commitCreatedProject: (projectId: string, prompt: string) => Promise<void>;
  homeProjectTab: "mine" | "shared";
  homePrompt: string;
  logout: () => Promise<void>;
  openProject: (projectId: string) => Promise<boolean>;
  persistedPrompt: string;
  projectDraft: string;
  projectSearch: string;
  routeView: WorkbenchRouteView;
  setActivePanel: (panel: CanvasPanel) => void;
  setActiveTool: (tool: CanvasInteractionMode) => void;
  setHomeProjectTab: (tab: "mine" | "shared") => void;
  setHomePrompt: (prompt: string) => void;
  setPersistedPrompt: (prompt: string) => void;
  setProjectDraft: (prompt: string) => void;
  setProjectSearch: (query: string) => void;
  user: WorkbenchUser | null;
  workbench: WorkbenchController;
};

export const WorkbenchRuntimeContext = createContext<WorkbenchRuntimeContextValue | null>(null);

export function useWorkbenchRuntime(): WorkbenchRuntimeContextValue {
  const value = useContext(WorkbenchRuntimeContext);
  if (!value) {
    throw new Error("useWorkbenchRuntime must be used inside WorkbenchRuntimeProvider");
  }
  return value;
}

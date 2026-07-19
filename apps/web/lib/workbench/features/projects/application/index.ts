"use client";

import {
  useWorkbenchProjectsApi,
  type WorkbenchProjectsApi,
} from "../api-adapter";

export type WorkbenchProjectOperations = Pick<
  WorkbenchProjectsApi,
  "createProject" | "getProjectBootstrap"
>;

export function useWorkbenchProjectOperations(): WorkbenchProjectOperations {
  return useWorkbenchProjectsApi();
}

export * from "./home-project-presenter";
export * from "./project-hooks";
export * from "./project-list-pagination";

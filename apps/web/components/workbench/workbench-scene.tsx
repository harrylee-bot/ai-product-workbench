"use client";

import { Suspense } from "react";

import { WorkbenchHomeRoute } from "./workbench-home-route";
import {
  preloadWorkbenchProjectRoute,
  readWorkbenchProjectRoute,
} from "./workbench-project-route-loader";
import { WorkbenchRouteTransition } from "./workbench-route-transition";
import {
  WorkbenchRuntimeContext,
  type WorkbenchRouteView,
  type WorkbenchRuntimeContextValue,
} from "./workbench-runtime-context";

export function WorkbenchScene({
  contextValue,
  onExitComplete,
  routeView,
}: {
  contextValue: WorkbenchRuntimeContextValue;
  onExitComplete: (projectId: string) => void;
  routeView: WorkbenchRouteView;
}) {
  return (
    <Suspense fallback={null}>
      <WorkbenchRouteTransition
        onExitComplete={() => onExitComplete(contextValue.workbench.selectedProjectId)}
        routeView={routeView}
      >
        <WorkbenchRuntimeContext.Provider value={contextValue}>
          {routeView === "home" ? (
            <WorkbenchHomeRoute />
          ) : (
            <WorkbenchProjectRouteSlot />
          )}
        </WorkbenchRuntimeContext.Provider>
      </WorkbenchRouteTransition>
    </Suspense>
  );
}

function WorkbenchProjectRouteSlot() {
  const routeModule = readWorkbenchProjectRoute();
  if (!routeModule) throw preloadWorkbenchProjectRoute();
  const ProjectRoute = routeModule.WorkbenchProjectRoute;
  return <ProjectRoute />;
}

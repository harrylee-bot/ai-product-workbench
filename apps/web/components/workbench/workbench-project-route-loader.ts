export type WorkbenchProjectRouteModule = typeof import("./workbench-project-route");

let projectRouteModulePromise: Promise<WorkbenchProjectRouteModule> | null = null;
let projectRouteModule: WorkbenchProjectRouteModule | null = null;

export function preloadWorkbenchProjectRoute(): Promise<WorkbenchProjectRouteModule> {
  projectRouteModulePromise ??= import("./workbench-project-route")
    .then((routeModule) => {
      projectRouteModule = routeModule;
      return routeModule;
    })
    .catch((error: unknown) => {
      projectRouteModulePromise = null;
      throw error;
    });
  return projectRouteModulePromise;
}

export function readWorkbenchProjectRoute(): WorkbenchProjectRouteModule | null {
  return projectRouteModule;
}

export async function continueAfterWorkbenchProjectRoutePreload<T>(
  continueTransition: () => T | Promise<T>,
  loadRoute: () => Promise<unknown> = preloadWorkbenchProjectRoute,
): Promise<T> {
  await loadRoute();
  return continueTransition();
}

import { describe, expect, it, vi } from "vitest";

import {
  continueAfterWorkbenchProjectRoutePreload,
  preloadWorkbenchProjectRoute,
  readWorkbenchProjectRoute,
} from "./workbench-project-route-loader";

describe("Workbench Project route preload", () => {
  it("does not commit the Home-to-Project transition before the route module resolves", async () => {
    let resolveRoute!: () => void;
    const loadRoute = vi.fn(() => new Promise<void>((resolve) => {
      resolveRoute = resolve;
    }));
    const commitTransition = vi.fn(() => "project-1");

    const transition = continueAfterWorkbenchProjectRoutePreload(
      commitTransition,
      loadRoute,
    );
    await Promise.resolve();

    expect(loadRoute).toHaveBeenCalledOnce();
    expect(commitTransition).not.toHaveBeenCalled();

    resolveRoute();

    await expect(transition).resolves.toBe("project-1");
    expect(commitTransition).toHaveBeenCalledOnce();
  });

  it("publishes the fulfilled route module for a synchronous transition render", async () => {
    const routeModule = await preloadWorkbenchProjectRoute();

    expect(readWorkbenchProjectRoute()).toBe(routeModule);
  }, 15_000);
});

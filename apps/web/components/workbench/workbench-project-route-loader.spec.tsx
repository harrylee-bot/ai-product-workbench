import { describe, expect, it } from "vitest";

import {
  preloadWorkbenchProjectRoute,
  readWorkbenchProjectRoute,
} from "./workbench-project-route-loader";

describe("Workbench Project route preload", () => {

  it("publishes the fulfilled route module for a synchronous transition render", async () => {
    const routeModule = await preloadWorkbenchProjectRoute();

    expect(readWorkbenchProjectRoute()).toBe(routeModule);
  }, 15_000);
});

// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkbenchRuntimeContextValue } from "./workbench-runtime-context";

const routeLoader = vi.hoisted(() => ({
  preload: vi.fn(),
  read: vi.fn(),
}));

vi.mock("./workbench-home-route", async () => {
  const { createElement } = await import("react");
  return {
    WorkbenchHomeRoute: () => createElement("section", { "data-testid": "home-route" }),
  };
});

vi.mock("./workbench-project-route-loader", () => ({
  preloadWorkbenchProjectRoute: routeLoader.preload,
  readWorkbenchProjectRoute: routeLoader.read,
}));

import { WorkbenchScene } from "./workbench-scene";

describe("Workbench Scene route loading", () => {
  beforeEach(() => {
    routeLoader.preload.mockReset();
    routeLoader.read.mockReset();
  });

  afterEach(cleanup);

  it("renders a preloaded Project synchronously during the Home transition", () => {
    const routeModule = projectRouteModule();
    routeLoader.read.mockReturnValue(routeModule);
    const rendered = renderScene("home");

    expect(rendered.getByTestId("home-route")).not.toBeNull();

    rendered.rerender(scene("project"));

    expect(rendered.getByTestId("project-route")).not.toBeNull();
    expect(routeLoader.preload).not.toHaveBeenCalled();
  });

  it("loads a cold Project deep link without substituting a Home route", async () => {
    const routeModule = projectRouteModule();
    let loaded = false;
    let resolveRoute!: () => void;
    const pendingRoute = new Promise<typeof routeModule>((resolve) => {
      resolveRoute = () => {
        loaded = true;
        resolve(routeModule);
      };
    });
    routeLoader.read.mockImplementation(() => loaded ? routeModule : null);
    routeLoader.preload.mockReturnValue(pendingRoute);

    const rendered = renderScene("project");

    expect(rendered.container.childElementCount).toBe(0);
    expect(rendered.queryByTestId("home-route")).toBeNull();

    await act(async () => resolveRoute());
    await waitFor(() => expect(rendered.getByTestId("project-route")).not.toBeNull());
  });
});

function renderScene(routeView: "home" | "project") {
  return render(scene(routeView));
}

function scene(routeView: "home" | "project") {
  return (
    <WorkbenchScene
      contextValue={{
        workbench: { selectedProjectId: routeView === "project" ? "project-1" : "" },
      } as unknown as WorkbenchRuntimeContextValue}
      onExitComplete={vi.fn()}
      routeView={routeView}
    />
  );
}

function projectRouteModule() {
  return {
    WorkbenchProjectRoute: () => <section data-testid="project-route" />,
  } as never;
}

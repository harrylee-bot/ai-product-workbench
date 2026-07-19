import { describe, expect, it } from "vitest";

import {
  currentWorkbenchRouteHref,
  normalizeWorkbenchRouteHref,
  workbenchRouteIsCommitted,
} from "./workbench-next-route-port";

describe("Workbench Next route port", () => {
  const location = {
    href: "https://workbench.example/projects/project-1?boardNode=old#canvas",
  };

  it("normalizes a same-origin destination with its complete query and hash", () => {
    expect(normalizeWorkbenchRouteHref(
      "/projects/project-1?boardNode=new&panel=versions#artifact",
      location,
    )).toBe("/projects/project-1?boardNode=new&panel=versions#artifact");
    expect(currentWorkbenchRouteHref(location))
      .toBe("/projects/project-1?boardNode=old#canvas");
  });

  it("does not acknowledge the same pathname until query and hash also match", () => {
    expect(workbenchRouteIsCommitted(
      "/projects/project-1?boardNode=new#artifact",
      location,
    )).toBe(false);
    expect(workbenchRouteIsCommitted(
      "/projects/project-1?boardNode=old#canvas",
      location,
    )).toBe(true);
  });

  it("rejects a route outside the Workbench origin", () => {
    expect(() => normalizeWorkbenchRouteHref("https://outside.example/projects/project-1", location))
      .toThrow("Cannot navigate the Workbench to another origin");
  });
});

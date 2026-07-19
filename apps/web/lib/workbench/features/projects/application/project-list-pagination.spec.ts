import { describe, expect, it } from "vitest";

import { shouldLoadMoreProjects } from "./project-list-pagination";

describe("Home Project cursor pagination", () => {
  it("loads only near the scroll boundary and suppresses duplicate requests", () => {
    const position = { clientHeight: 600, scrollHeight: 1_600 };

    expect(shouldLoadMoreProjects({
      ...position,
      hasNextPage: true,
      isFetchingNextPage: false,
      scrollTop: 759,
    })).toBe(false);
    expect(shouldLoadMoreProjects({
      ...position,
      hasNextPage: true,
      isFetchingNextPage: false,
      scrollTop: 760,
    })).toBe(true);
    expect(shouldLoadMoreProjects({
      ...position,
      hasNextPage: true,
      isFetchingNextPage: true,
      scrollTop: 900,
    })).toBe(false);
    expect(shouldLoadMoreProjects({
      ...position,
      hasNextPage: false,
      isFetchingNextPage: false,
      scrollTop: 900,
    })).toBe(false);
  });
});

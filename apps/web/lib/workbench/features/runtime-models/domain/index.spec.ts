import { describe, expect, it } from "vitest";

import {
  resolveWorkbenchModelChoiceKey,
  toWorkbenchModelCatalogState,
} from "./index";

describe("Runtime Model catalog domain", () => {
  it("distinguishes loading, error, empty, and ready catalog states", () => {
    expect(toWorkbenchModelCatalogState(queryState({ isPending: true }), 0))
      .toEqual({ error: null, retrying: false, status: "loading" });

    const error = new Error("catalog unavailable");
    expect(toWorkbenchModelCatalogState(queryState({
      error,
      isError: true,
      isFetching: true,
    }), 0)).toEqual({ error, retrying: true, status: "error" });

    expect(toWorkbenchModelCatalogState(queryState(), 0))
      .toEqual({ error: null, retrying: false, status: "empty" });
    expect(toWorkbenchModelCatalogState(queryState(), 2))
      .toEqual({ error: null, retrying: false, status: "ready" });
  });

  it("preserves a recovered selection and otherwise falls back to the first model", () => {
    const choices = [{ key: "default" }, { key: "selected" }];

    expect(resolveWorkbenchModelChoiceKey("selected", choices)).toBe("selected");
    expect(resolveWorkbenchModelChoiceKey("removed", choices)).toBe("default");
    expect(resolveWorkbenchModelChoiceKey("selected", [])).toBe("");
  });
});

function queryState(overrides: Partial<{
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
}> = {}) {
  return {
    error: null,
    isError: false,
    isFetching: false,
    isPending: false,
    ...overrides,
  };
}

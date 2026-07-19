// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createWorkbenchQueryClient, WorkbenchQueryProvider } from "./provider";

describe("Workbench private query cache identity boundary", () => {
  it("preserves cache for the same principal and clears it on switch and logout", () => {
    const queryClient = createWorkbenchQueryClient();
    const rendered = render(
      <WorkbenchQueryProvider
        privateCacheNamespace="principal-a"
        queryClient={queryClient}
      >
        <div />
      </WorkbenchQueryProvider>,
    );
    queryClient.setQueryData(["private", "preference"], { favorite: true });

    rendered.rerender(
      <WorkbenchQueryProvider
        privateCacheNamespace="principal-a"
        queryClient={queryClient}
      >
        <div />
      </WorkbenchQueryProvider>,
    );
    expect(queryClient.getQueryData(["private", "preference"]))
      .toEqual({ favorite: true });

    act(() => {
      rendered.rerender(
        <WorkbenchQueryProvider
          privateCacheNamespace="principal-b"
          queryClient={queryClient}
        >
          <div />
        </WorkbenchQueryProvider>,
      );
    });
    expect(queryClient.getQueryData(["private", "preference"])).toBeUndefined();

    queryClient.setQueryData(["private", "preference"], { favorite: false });
    act(() => {
      rendered.rerender(
        <WorkbenchQueryProvider
          privateCacheNamespace={null}
          queryClient={queryClient}
        >
          <div />
        </WorkbenchQueryProvider>,
      );
    });
    expect(queryClient.getQueryData(["private", "preference"])).toBeUndefined();
    rendered.unmount();
  });
});

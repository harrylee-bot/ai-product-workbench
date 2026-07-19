// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchArtifactsApi,
  WorkbenchArtifactsApi,
} from "./index";

describe("Artifacts API adapter hook", () => {
  it("keeps one feature-owned adapter instance", () => {
    const rendered = renderHook(() => useWorkbenchArtifactsApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchArtifactsApi);
    rendered.unmount();
  });
});

// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchExportsApi,
  WorkbenchExportsApi,
} from "./index";

describe("Exports API adapter hook", () => {
  it("keeps one feature-owned adapter instance", () => {
    const rendered = renderHook(() => useWorkbenchExportsApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchExportsApi);
    rendered.unmount();
  });

  it("accepts a Fetch Blob created in a different JavaScript realm", async () => {
    const bytes = new Uint8Array([60, 104, 49, 62]);
    const api = new WorkbenchExportsApi(createWorkbenchApiClient({
      baseUrl: `${window.location.origin}/api/v1`,
      fetch: vi.fn(async () => new Response(bytes, {
        headers: { ETag: '"content-hash"' },
      })),
    }));

    const result = await api.getExportContent("export-1");

    expect(result.value).not.toBeInstanceOf(Blob);
    expect(Object.prototype.toString.call(result.value)).toBe("[object Blob]");
    expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(bytes);
    expect(result.etag).toBe('"content-hash"');
  });
});

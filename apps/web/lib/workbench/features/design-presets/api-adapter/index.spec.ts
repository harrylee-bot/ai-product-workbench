// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchTransportProvider } from "../../../transport/context";
import {
  useWorkbenchDesignPresetsApi,
  WorkbenchDesignPresetsApi,
} from "./index";

describe("Design Presets API contracts", () => {
  it("keeps one feature-owned adapter instance", () => {
    const rendered = renderHook(() => useWorkbenchDesignPresetsApi(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(
        WorkbenchTransportProvider,
        null,
        children,
      ),
    });
    const first = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(first);
    expect(first).toBeInstanceOf(WorkbenchDesignPresetsApi);
    rendered.unmount();
  });

  it("loads and validates the server-authoritative catalog", async () => {
    const catalog = { items: [] };
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`${window.location.origin}/api/v1/design-presets`);
      expect(request.method).toBe("GET");
      return Response.json(catalog);
    });
    const api = new WorkbenchDesignPresetsApi(createWorkbenchApiClient({
      baseUrl: `${window.location.origin}/api/v1`,
      fetch,
    }));

    await expect(api.listDesignPresets()).resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects an invalid catalog response", async () => {
    const api = new WorkbenchDesignPresetsApi(createWorkbenchApiClient({
      baseUrl: `${window.location.origin}/api/v1`,
      fetch: vi.fn(async () => Response.json({ items: [{}] })),
    }));

    await expect(api.listDesignPresets()).rejects
      .toBeInstanceOf(WorkbenchContractError);
  });
});

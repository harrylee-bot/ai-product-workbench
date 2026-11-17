// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useCancelWorkbenchPrototypeV2Plan } from "./index";

const cancelPlan = vi.hoisted(() => vi.fn());
vi.mock("../api-adapter", () => ({ useWorkbenchPrototypeV2Api: () => ({ cancelPlan }) }));

describe("prototype command retries", () => {
  it("reuses the failed request key after a lost response, and starts a new key only after success", async () => {
    cancelPlan.mockReset().mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue({ value: { id: "child-plan" }, etag: '"0"' });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useCancelWorkbenchPrototypeV2Plan("project-one", "plan-one"), { wrapper });
    await act(async () => { await expect(hook.result.current.mutateAsync({ ifMatch: '"4"', request: { reason: "Stop this run" } })).rejects.toThrow("Connection lost"); });
    await act(async () => { await hook.result.current.mutateAsync({ ifMatch: '"4"', request: { reason: "Stop this run" } }); });
    expect(cancelPlan.mock.calls[0]).toEqual(cancelPlan.mock.calls[1]);
    expect(cancelPlan.mock.calls[0]![4]).toMatch(/^prototype-command:/);
    await act(async () => { await hook.result.current.mutateAsync({ ifMatch: '"4"', request: { reason: "Stop this run" } }); });
    expect(cancelPlan.mock.calls[2]![4]).not.toBe(cancelPlan.mock.calls[0]![4]);
    hook.unmount(); client.clear();
  });
});

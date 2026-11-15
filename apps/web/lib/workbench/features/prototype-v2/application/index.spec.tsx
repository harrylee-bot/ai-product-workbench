// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReviseWorkbenchPrototypeV2Revision } from "./index";

const reviseRevision = vi.hoisted(() => vi.fn());
vi.mock("../api-adapter", () => ({ useWorkbenchPrototypeV2Api: () => ({ reviseRevision }) }));

describe("prototype command retries", () => {
  it("reuses the failed request key after a lost response, and starts a new key only after success", async () => {
    reviseRevision.mockReset().mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValue({ value: { id: "child-plan" }, etag: '"0"' });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useReviseWorkbenchPrototypeV2Revision("project-one", "revision-one"), { wrapper });
    await act(async () => { await expect(hook.result.current.mutateAsync({ ifMatch: '"4"', request: { feedbackIds: ["feedback-one"] } })).rejects.toThrow("Connection lost"); });
    await act(async () => { await hook.result.current.mutateAsync({ ifMatch: '"4"', request: { feedbackIds: ["feedback-one"] } }); });
    expect(reviseRevision.mock.calls[0]).toEqual(reviseRevision.mock.calls[1]);
    expect(reviseRevision.mock.calls[0]![4]).toMatch(/^prototype-command:/);
    await act(async () => { await hook.result.current.mutateAsync({ ifMatch: '"4"', request: { feedbackIds: ["feedback-one"] } }); });
    expect(reviseRevision.mock.calls[2]![4]).not.toBe(reviseRevision.mock.calls[0]![4]);
    hook.unmount(); client.clear();
  });
});

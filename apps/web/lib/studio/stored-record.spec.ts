// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { studioRecordKey, useStudioStoredRecord } from "./stored-record";
const schema = z.object({ text: z.string() }).strict();
beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("isolates user/project/version drafts and rejects a late writer after leaving and returning to the same scope", () => {
  const key = studioRecordKey("a:b", "project", "document", "version-one")!;
  const hook = renderHook(({ scope }) => useStudioStoredRecord(scope, schema), {
    initialProps: { scope: key },
  });
  const stale = hook.result.current;
  act(() => stale.save({ text: "private draft" }));
  hook.rerender({
    scope: studioRecordKey("a", "b:project", "document", "version-one")!,
  });
  expect(hook.result.current.value).toBeNull();
  hook.rerender({ scope: key });
  expect(hook.result.current.value).toEqual({ text: "private draft" });
  act(() => stale.save({ text: "late overwrite" }));
  expect(hook.result.current.value).toEqual({ text: "private draft" });
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
    text: "private draft",
  });
  hook.unmount();
  expect(stale.isCurrent()).toBe(false);
});
it("logout prevents a late write from recreating a cleared private record", () => {
  const key = studioRecordKey("user", "project", "image")!;
  const hook = renderHook(() => useStudioStoredRecord(key, schema));
  const stale = hook.result.current;
  act(() => {
    stale.save({ text: "private" });
    window.dispatchEvent(new Event("workbench:logout"));
    sessionStorage.clear();
  });
  act(() => stale.save({ text: "late" }));
  expect(hook.result.current.value).toBeNull();
  expect(sessionStorage.length).toBe(0);
});
it("rejects malformed persisted commands and reports unavailable persistence while preserving the in-memory draft", () => {
  const key = studioRecordKey("user", "project", "edit")!;
  sessionStorage.setItem(key, '{"bad":true}');
  const hook = renderHook(() => useStudioStoredRecord(key, schema));
  expect(hook.result.current.value).toBeNull();
  expect(hook.result.current.error).toContain("无法恢复");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("quota", "QuotaExceededError");
  });
  act(() => hook.result.current.save({ text: "keep this draft" }));
  expect(hook.result.current.value).toEqual({ text: "keep this draft" });
  expect(hook.result.current.error).toContain("刷新页面会丢失");
});

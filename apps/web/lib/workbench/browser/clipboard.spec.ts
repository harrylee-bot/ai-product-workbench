// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { WorkbenchClipboardError, writeWorkbenchClipboard } from "./clipboard";

describe("Workbench clipboard adapter", () => {
  it("uses the asynchronous Clipboard API when the browser grants it", async () => {
    const writeText = vi.fn(async () => undefined);

    await writeWorkbenchClipboard("project link", {
      navigator: { clipboard: { writeText } },
      document,
    });

    expect(writeText).toHaveBeenCalledWith("project link");
  });

  it("falls back after Clipboard API rejection and verifies legacy copy success", async () => {
    const writeText = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await writeWorkbenchClipboard("prompt", {
      navigator: { clipboard: { writeText } },
      document,
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("rejects instead of reporting success when every browser path fails", async () => {
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    await expect(writeWorkbenchClipboard("prompt", {
      navigator: undefined,
      document,
    })).rejects.toBeInstanceOf(WorkbenchClipboardError);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

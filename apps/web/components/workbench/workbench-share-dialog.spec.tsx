// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchShareDialog } from "./workbench-share-dialog";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/workbench/browser/clipboard", () => ({
  writeWorkbenchClipboard: mocks.copy,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

beforeEach(() => {
  mocks.copy.mockReset().mockResolvedValue(undefined);
  mocks.toastError.mockReset();
});

afterEach(cleanup);

describe("Workbench Share dialog", () => {
  it("traps focus, closes on Escape, and restores the opener with modal semantics", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const outerEscapeHandler = vi.fn();
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") outerEscapeHandler();
    };
    document.addEventListener("keydown", handleDocumentKeyDown);

    try {
      render(<AccessibleShareDialogHarness onOpenChange={onOpenChange} />);
      const opener = screen.getByRole("button", { name: "打开共享" });

      await user.click(opener);

      const dialog = await screen.findByRole("dialog", { name: "共享" });
      expect(dialog.tagName).toBe("ASIDE");
      expect(dialog.previousElementSibling?.classList.contains("workbench-dialog-backdrop")).toBe(true);
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      const closeButton = screen.getByRole("button", { name: "关闭共享" });
      await waitFor(() => expect(document.activeElement).toBe(closeButton));

      await user.tab({ shift: true });
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "复制链接" }));
      await user.tab();
      expect(document.activeElement).toBe(closeButton);

      await user.keyboard("{Escape}");

      await waitFor(() => expect(screen.queryByRole("dialog", { name: "共享" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(outerEscapeHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    }
  });

  it("keeps backdrop clicks as a single close transition and restores focus", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<AccessibleShareDialogHarness onOpenChange={onOpenChange} />);
    const opener = screen.getByRole("button", { name: "打开共享" });

    await user.click(opener);
    await screen.findByRole("dialog", { name: "共享" });
    const backdrop = document.querySelector<HTMLElement>(".workbench-dialog-backdrop");
    expect(backdrop).not.toBeNull();

    await user.click(backdrop!);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "共享" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows copied state only after the browser confirms the clipboard write", async () => {
    const onEnsureLink = vi.fn(async () => "https://workbench.test/share/token");
    renderDialog(onEnsureLink);

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));

    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(
      "https://workbench.test/share/token",
    ));
    expect(await screen.findByRole("button", { name: "已复制链接" })).not.toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("keeps the copy action retryable and reports clipboard rejection", async () => {
    mocks.copy.mockRejectedValue(new Error("clipboard denied"));
    renderDialog(vi.fn(async () => "https://workbench.test/share/token"));

    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "复制链接失败，请检查浏览器剪贴板权限",
    ));
    expect(screen.getByRole("button", { name: "复制链接" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "已复制链接" })).toBeNull();
  });

  it("does not present an unknown Share state as disabled sharing and retries its query", async () => {
    const onRetryState = vi.fn(async () => undefined);
    render(
      <WorkbenchShareDialog
        busy={false}
        error={null}
        onEnsureLink={vi.fn(async () => "https://workbench.test/share/token")}
        onOpenChange={vi.fn()}
        onRetryState={onRetryState}
        onToggle={vi.fn(async () => "share-id")}
        open
        shareEnabled={false}
        shareUrl={null}
        stateError={new Error("share query unavailable")}
        statePending={false}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "启用共享和重混功能",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "共享状态加载失败，重试" }));
    await waitFor(() => expect(onRetryState).toHaveBeenCalledOnce());
  });
});

function AccessibleShareDialogHarness({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const updateOpen = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    setOpen(nextOpen);
  };

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">打开共享</button>
      <WorkbenchShareDialog
        busy={false}
        error={null}
        onEnsureLink={vi.fn(async () => "https://workbench.test/share/token")}
        onOpenChange={updateOpen}
        onRetryState={vi.fn(async () => undefined)}
        onToggle={vi.fn(async () => "share-id")}
        open={open}
        shareEnabled
        shareUrl="https://workbench.test/share/token"
        stateError={null}
        statePending={false}
      />
    </>
  );
}

function renderDialog(onEnsureLink: () => Promise<string>) {
  return render(
    <WorkbenchShareDialog
      busy={false}
      error={null}
      onEnsureLink={onEnsureLink}
      onOpenChange={vi.fn()}
      onRetryState={vi.fn(async () => undefined)}
      onToggle={vi.fn(async () => "share-id")}
      open
      shareEnabled
      shareUrl="https://workbench.test/share/token"
      stateError={null}
      statePending={false}
    />,
  );
}

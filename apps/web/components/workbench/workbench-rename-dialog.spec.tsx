// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RenameProjectDialog } from "./workbench-rename-dialog";

afterEach(cleanup);

describe("RenameProjectDialog", () => {
  it("labels the title field, traps focus, closes on Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => undefined);
    render(<RenameDialogHarness onRename={onRename} />);
    const opener = screen.getByRole("button", { name: "打开重命名" });

    await user.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "重命名所选内容" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const input = screen.getByRole("textbox", { name: "新标题" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await user.clear(input);
    await user.type(input, "Renamed");

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "保存" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "重命名所选内容" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(onRename).not.toHaveBeenCalled();
  });
});

function RenameDialogHarness({
  onRename,
}: {
  onRename: (title: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">打开重命名</button>
      {open && (
        <RenameProjectDialog
          currentTitle="Original"
          dialogLabel="重命名所选内容"
          heading="重命名所选内容"
          onClose={() => setOpen(false)}
          onRename={onRename}
        />
      )}
    </>
  );
}

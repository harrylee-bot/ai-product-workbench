// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftableInput } from "./draftable-input";
afterEach(cleanup);
describe("Onlook dimension input adaptation", () => {
  it("allows incomplete typing, commits on Enter and restores on Escape without committing", () => {
    const save = vi.fn();
    render(
      <DraftableInput aria-label="宽" value="1280" onChangeValue={save} />,
    );
    const input = screen.getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: "390" } });
    expect(save).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(save).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("1280");
    input.focus();
    fireEvent.change(input, { target: { value: "768" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(save).toHaveBeenLastCalledWith("768");
  });
});

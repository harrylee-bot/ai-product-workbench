// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchCanvasMediaPanel, cropImageFile } from "./workbench-canvas-media-panel";

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:media") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(cleanup);

describe("产品工作台 Media panel", () => {
  it("accepts a supported image and submits the selected file", async () => {
    const onInsert = vi.fn(async () => undefined);
    const rendered = render(
      <WorkbenchCanvasMediaPanel onClose={vi.fn()} onInsert={onInsert} projectId="project-1" />,
    );
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["image"], "screen.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });
    await userEvent.click(screen.getByRole("button", { name: "插入图片" }));

    expect(onInsert).toHaveBeenCalledWith(file, expect.stringMatching(/^media:[A-Za-z0-9_-]{24}$/));
  });

  it("rejects unsupported files before upload", () => {
    const rendered = render(
      <WorkbenchCanvasMediaPanel onClose={vi.fn()} onInsert={vi.fn()} projectId="project-1" />,
    );
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [new File(["svg"], "shape.svg", { type: "image/svg+xml" })] },
    });

    expect(screen.getByRole("alert").textContent).toContain("请选择 PNG、JPEG 或 WebP 图片");
    expect((screen.getByRole("button", { name: "插入图片" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the source file when the cropper has not produced an area", async () => {
    const file = new File(["image"], "screen.webp", { type: "image/webp" });
    await expect(cropImageFile(file, null)).resolves.toBe(file);
  });

  it("clears the previous Project file without remounting and drops its pending crop", async () => {
    const projectOneInsert = vi.fn(async () => undefined);
    const projectTwoInsert = vi.fn(async () => undefined);
    const rendered = render(
      <WorkbenchCanvasMediaPanel
        onClose={vi.fn()}
        onInsert={projectOneInsert}
        projectId="project-1"
      />,
    );
    const root = rendered.container.querySelector("[data-workbench-canvas-media-panel]");
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["image"], "project-one.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText("project-one.png")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "插入图片" }));
    rendered.rerender(
      <WorkbenchCanvasMediaPanel
        onClose={vi.fn()}
        onInsert={projectTwoInsert}
        projectId="project-2"
      />,
    );

    expect(rendered.container.querySelector("[data-workbench-canvas-media-panel]")).toBe(root);
    expect(screen.getByText("图片素材")).not.toBeNull();
    expect((screen.getByRole("button", { name: "插入图片" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => Promise.resolve());
    expect(projectOneInsert).not.toHaveBeenCalled();
    expect(projectTwoInsert).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ExportPreviewTokenResponse } from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const previewHarness = vi.hoisted(() => ({
  capability: {
    url: "https://preview.example.test/preview/wbpv1-short-lived",
    expiresAt: "2099-01-01T00:00:00.000Z",
  } satisfies ExportPreviewTokenResponse,
}));

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ title, value }: { title?: string; value: string }) => (
    <div aria-label={title} data-qr-value={value} />
  ),
}));

vi.mock("./workbench-isolated-preview", () => ({
  WorkbenchIsolatedPreview: ({
    onCapabilityChange,
  }: {
    onCapabilityChange?: (capability: ExportPreviewTokenResponse | null) => void;
  }) => (
    <button
      data-isolated-preview-mock
      onClick={() => onCapabilityChange?.(previewHarness.capability)}
      type="button"
    >
      Preview ready
    </button>
  ),
}));

import { ProjectPreviewOverlay } from "./workbench-project-preview-overlay";

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 800,
    height: 800,
    left: 0,
    right: 1_200,
    top: 0,
    width: 1_200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.stubGlobal("ResizeObserver", class MockResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback([], this as unknown as ResizeObserver);
    }
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Project Preview overlay", () => {
  it("switches real iframe viewport presets without remounting the Preview capability", async () => {
    renderOverlay();
    const preview = screen.getByRole("button", { name: "Preview ready" });
    expect(deviceFrame().dataset.previewDevice).toBe("mobile");
    expect(deviceFrame().dataset.previewWidth).toBe("390");
    expect(deviceFrame().dataset.previewHeight).toBe("844");

    fireEvent.click(screen.getByRole("button", { name: "桌面" }));
    expect(deviceFrame().dataset.previewDevice).toBe("desktop");
    expect(deviceFrame().dataset.previewWidth).toBe("1440");
    expect(deviceFrame().dataset.previewHeight).toBe("900");
    expect(screen.getByRole("button", { name: "Preview ready" })).toBe(preview);

    fireEvent.click(screen.getByRole("button", { name: "响应式" }));
    await waitFor(() => expect(deviceFrame().dataset.previewWidth).toBe("1176"));
    expect(deviceFrame().dataset.previewHeight).toBe("776");
  });

  it("supports bounded custom viewport dimensions", () => {
    renderOverlay();
    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "自定义预览宽度" }), {
      target: { value: "1280" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "自定义预览高度" }), {
      target: { value: "720" },
    });
    expect(deviceFrame().dataset.previewWidth).toBe("1280");
    expect(deviceFrame().dataset.previewHeight).toBe("720");
  });

  it("enables QR only for a ready short-lived capability and encodes its exact URL", async () => {
    renderOverlay();
    const qrTrigger = screen.getByRole("button", { name: "二维码预览" });
    expect((qrTrigger as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Preview ready" }));
    expect((qrTrigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(qrTrigger);

    const qr = await screen.findByLabelText("短期预览二维码");
    expect(qr.getAttribute("data-qr-value")).toBe(previewHarness.capability.url);
    expect(screen.getByRole("link", { name: "在新窗口打开预览" }).getAttribute("href"))
      .toBe(previewHarness.capability.url);
    expect(document.body.textContent).not.toContain("wbpv1-short-lived");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderOverlay(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderOverlay(onClose = vi.fn()) {
  return render(
    <ProjectPreviewOverlay
      artifacts={[{
        reference: {
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
          screenId: "screen-home",
        },
        title: "Home",
      }]}
      createPreview={vi.fn()}
      initialReference={{
        projectId: "project-1",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        screenId: "screen-home",
      }}
      onClose={onClose}
      projectId="project-1"
      projectTitle="产品工作台"
    />,
  );
}

function deviceFrame() {
  const frame = document.querySelector("[data-preview-device]");
  if (!(frame instanceof HTMLElement)) throw new Error("Preview device frame missing");
  return frame;
}

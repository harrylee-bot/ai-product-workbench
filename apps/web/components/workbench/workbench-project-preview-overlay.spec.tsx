// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ExportPreviewTokenResponse } from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    request,
  }: {
    onCapabilityChange?: (capability: ExportPreviewTokenResponse | null) => void;
    request: unknown;
  }) => (
    <button
      data-preview-request={JSON.stringify(request)}
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
  it.each([375, 768, 1_440])(
    "keeps screen navigation, actions, and device controls in non-overlapping regions at %ipx",
    (viewportWidth) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: viewportWidth,
      });
      renderOverlay(vi.fn(), {
        artifactTitles: Array.from(
          { length: 9 },
          (_, index) => `第 ${index + 1} 个较长的项目页面名称`,
        ),
        projectId: `project-layout-${viewportWidth}`,
        screenId: "screen-home",
      });

      const header = requiredElement("[data-preview-header]");
      const project = requiredElement("[data-preview-project]");
      const navigation = screen.getByRole("navigation", { name: "预览页面" });
      const tabs = screen.getByRole("tablist", { name: "预览页面" });
      const actions = screen.getByRole("group", { name: "预览操作" });
      const body = requiredElement("[data-preview-body]");
      const deviceControls = requiredElement("[data-preview-device-controls]");

      expect(header.classList.contains("grid")).toBe(true);
      expect(header.className).toContain("max-lg:grid-rows-[46px_46px]");
      expect(header.contains(project)).toBe(true);
      expect(header.contains(navigation)).toBe(true);
      expect(header.contains(actions)).toBe(true);
      expect(navigation.classList.contains("min-w-0")).toBe(true);
      expect(navigation.classList.contains("overflow-x-auto")).toBe(true);
      expect(navigation.classList.contains("absolute")).toBe(false);
      expect(tabs.classList.contains("w-max")).toBe(true);
      expect(tabs.classList.contains("min-w-full")).toBe(true);
      expect(screen.getAllByRole("tab")).toHaveLength(9);
      expect(within(actions).getByRole("button", { name: "二维码预览" })).toBeTruthy();
      expect(within(actions).getByRole("button", { name: "刷新预览" })).toBeTruthy();
      expect(body.className).toContain("max-lg:top-[104px]");
      expect(deviceControls.classList.contains("overflow-x-auto")).toBe(true);
      expect(screen.getByRole("toolbar", { name: "预览设备" })).toBeTruthy();
    },
  );

  it("supports roving keyboard navigation across an overflowing screen tab list", () => {
    const titles = Array.from({ length: 8 }, (_, index) => `页面 ${index + 1}`);
    renderOverlay(vi.fn(), {
      artifactTitles: titles,
      projectId: "project-keyboard-tabs",
      screenId: "screen-home",
    });
    const tabs = screen.getAllByRole("tab");

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(tabs[0]!, { key: "End" });
    const lastTab = tabs.at(-1);
    expect(lastTab?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(lastTab);
    expect(JSON.parse(
      screen.getByRole("button", { name: "Preview ready" }).dataset.previewRequest!,
    ).initialScreenId).toBe("screen-8");

    fireEvent.keyDown(lastTab!, { key: "ArrowRight" });
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);
  });

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
    expect(deviceFrame().dataset.previewScale).toBe("1");
  });

  it("previews the complete Prototype Artifact with the selected screen as its initial screen", () => {
    renderOverlay();
    expect(JSON.parse(
      screen.getByRole("button", { name: "Preview ready" }).dataset.previewRequest!,
    )).toEqual({
      initialScreenId: "screen-home",
      selection: {
        kind: "artifact",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
      },
    });
  });

  it("previews a complete Prototype without an explicit initial screen", () => {
    renderOverlay(vi.fn(), { screenId: undefined });
    expect(JSON.parse(
      screen.getByRole("button", { name: "Preview ready" }).dataset.previewRequest!,
    )).toEqual({
      initialScreenId: null,
      selection: {
        kind: "artifact",
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
      },
    });
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

function renderOverlay(
  onClose = vi.fn(),
  options: {
    artifactTitles?: string[];
    projectId?: string;
    screenId?: string;
  } = { screenId: "screen-home" },
) {
  const projectId = options.projectId ?? "project-1";
  const artifactTitles = options.artifactTitles ?? ["Home"];
  const artifacts = artifactTitles.map((title, index) => ({
    reference: {
      projectId,
      artifactId: `artifact-${index + 1}`,
      artifactVersionId: `version-${index + 1}`,
      ...(index === 0
        ? options.screenId ? { screenId: options.screenId } : {}
        : { screenId: `screen-${index + 1}` }),
    },
    title,
  }));
  const reference = artifacts[0]!.reference;
  return render(
    <ProjectPreviewOverlay
      artifacts={artifacts}
      createPreview={vi.fn()}
      initialReference={reference}
      onClose={onClose}
      projectId={projectId}
      projectTitle="产品工作台"
    />,
  );
}

function deviceFrame() {
  const frame = document.querySelector("[data-preview-device]");
  if (!(frame instanceof HTMLElement)) throw new Error("Preview device frame missing");
  return frame;
}

function requiredElement(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Element missing: ${selector}`);
  return element;
}

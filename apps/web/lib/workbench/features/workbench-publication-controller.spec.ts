import type { ExternalExportDelivery } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createBoardStore } from "./board";
import {
  exportTargetAvailability,
  copyExportHtmlToClipboard,
  exportFormatForTarget,
  exportTargetForExternalDelivery,
  flushWorkbenchBoard,
  selectLatestRestorableExternalDelivery,
  validateIsolatedPreviewCapability,
  waitForProjectPreview,
  waitForPreviewExport,
} from "./workbench-publication-controller";
import {
  canonicalizeExportSelection,
  exportSelectionIdentityKey,
  exportSelectionsEqual,
} from "./export-selection";

describe("Workbench publication controller", () => {
  it("maps every visible export target to the closed contract enum", () => {
    expect(exportFormatForTarget("Figma")).toBe("figma");
    expect(exportFormatForTarget("Download .zip")).toBe("html");
    expect(exportFormatForTarget("Copy code")).toBe("html");
    expect(exportFormatForTarget("React")).toBe("react");
    expect(exportFormatForTarget("MCP")).toBe("mcp");
    expect(exportTargetForExternalDelivery("ai_studio")).toBe("AI Studio");
    expect(exportTargetForExternalDelivery("netlify")).toBe("Netlify");
  });

  it("restores only the newest non-cancelled external delivery", () => {
    const pending = externalDelivery({ id: "delivery-pending", status: "pending_confirmation" });
    const cancelled = externalDelivery({ id: "delivery-cancelled", status: "cancelled" });
    expect(selectLatestRestorableExternalDelivery([pending, cancelled])).toBe(pending);
    expect(selectLatestRestorableExternalDelivery([cancelled, pending])).toBeNull();
    expect(selectLatestRestorableExternalDelivery([])).toBeNull();
  });

  it("uses canonical set semantics for Board-node Export identity and cache keys", () => {
    const left = { kind: "board_nodes" as const, nodeIds: ["node-b", "node-a"] };
    const right = { kind: "board_nodes" as const, nodeIds: ["node-a", "node-b"] };
    expect(canonicalizeExportSelection({
      kind: "board_nodes",
      nodeIds: ["node-b", "node-a", "node-b"],
    })).toEqual({ kind: "board_nodes", nodeIds: ["node-a", "node-b"] });
    expect(canonicalizeExportSelection({
      kind: "board_nodes",
      nodeIds: ["\u{10000}", "\ue000"],
    })).toEqual({ kind: "board_nodes", nodeIds: ["\ue000", "\u{10000}"] });
    expect(exportSelectionsEqual(left, right)).toBe(true);
    expect(exportSelectionIdentityKey(left)).toBe(exportSelectionIdentityKey(right));
    expect(exportSelectionsEqual(left, {
      kind: "board_nodes",
      nodeIds: ["node-a", "node-c"],
    })).toBe(false);
  });

  it("surfaces clipboard denial while reusing the generated HTML bytes", async () => {
    const blob = new Blob(["<!doctype html><title>Products</title>"], { type: "text/html" });
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    await expect(copyExportHtmlToClipboard(blob, { writeText })).rejects.toThrow("Denied");
    expect(writeText).toHaveBeenCalledWith("<!doctype html><title>Products</title>");
  });

  it("keeps Prototype screen identity in Preview cache keys", () => {
    const home = {
      kind: "artifact" as const,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenId: "screen-home",
    };
    const success = { ...home, screenId: "screen-success" };
    expect(exportSelectionsEqual(home, success)).toBe(false);
    expect(exportSelectionIdentityKey(home)).not.toBe(exportSelectionIdentityKey(success));
  });

  it("fails Figma closed until the server capability is available", () => {
    expect(exportTargetAvailability(null, "Figma")).toEqual({
      available: false,
      reason: "正在检查导出能力",
    });
    const available = { available: true as const, authentication: "not_required" as const, reasonCode: null };
    const authRequired = { available: false as const, authentication: "required" as const, reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const };
    expect(exportTargetAvailability({
      formats: {
        html: available,
        react: available,
        figma: { available: false, authentication: "not_required", reasonCode: "EXPORT_FIGMA_UNAVAILABLE" },
        mcp: available,
      },
      packaging: { single_file: available, zip: available },
      external: {
        ai_studio: { available: false, authentication: "not_required", reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" },
        netlify: authRequired,
        lovable: authRequired,
        bolt: authRequired,
      },
    }, "Figma")).toEqual({
      available: false,
      reason: "当前部署尚未完成 Figma 导出验收",
    });
    expect(exportTargetAvailability(null, "React")).toEqual({
      available: false,
      reason: "正在检查导出能力",
    });
  });

  it("publishes only after a dirty Board reaches a committed revision", async () => {
    const store = createBoardStore({
      id: "board_1",
      projectId: "project_1",
      revision: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    });
    store.getState().setViewport({ x: 20, y: 10, zoom: 0.8 });
    const save = vi.fn(async () => {
      const snapshot = store.getState().prepareSave();
      expect(snapshot).not.toBeNull();
      store.getState().completeSave(snapshot!, {
        id: "board_1",
        projectId: "project_1",
        revision: 4,
        viewport: { x: 20, y: 10, zoom: 0.8 },
        nodes: [],
        edges: [],
      }, '"4"');
      return {
        value: {
          id: "board_1",
          projectId: "project_1",
          revision: 4,
          viewport: { x: 20, y: 10, zoom: 0.8 },
          nodes: [],
          edges: [],
        },
        etag: '"4"',
      };
    });

    await expect(flushWorkbenchBoard({ store, save })).resolves.toEqual({
      id: "board_1",
      revision: 4,
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it("refuses to publish a conflicted Board", async () => {
    const store = createBoardStore({
      id: "board_1",
      projectId: "project_1",
      revision: 3,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    });
    store.getState().setViewport({ x: 1, y: 1, zoom: 1 });
    store.getState().reconcileFromServer({
      id: "board_1",
      projectId: "project_1",
      revision: 4,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    }, '"4"');

    await expect(flushWorkbenchBoard({ store, save: vi.fn() }))
      .rejects.toThrow("changed remotely");
  });

  it("waits for an HTML Export terminal state before minting a Preview", async () => {
    const queued = exportJob({ status: "queued" });
    const running = exportJob({
      status: "running",
      revision: 1,
      startedAt: "2026-07-13T12:00:01.000Z",
    });
    const succeeded = exportJob({
      status: "succeeded",
      revision: 2,
      startedAt: "2026-07-13T12:00:01.000Z",
      finishedAt: "2026-07-13T12:00:02.000Z",
      output: {
        mode: "blob",
        blobId: "blob-1",
        mediaType: "text/html; charset=utf-8",
        byteSize: 100,
        sha256: "a".repeat(64),
      },
    });
    const getExportJob = vi.fn()
      .mockResolvedValueOnce({ value: running, etag: '"1"' })
      .mockResolvedValueOnce({ value: succeeded, etag: '"2"' });

    await expect(waitForPreviewExport({ getExportJob }, queued, {
      intervalMs: 0,
      timeoutMs: 1_000,
    })).resolves.toEqual(succeeded);
    expect(getExportJob).toHaveBeenCalledTimes(2);
  });

  it("fails closed for terminal Export failures and cancellation", async () => {
    await expect(waitForPreviewExport({ getExportJob: vi.fn() }, exportJob({
      status: "failed",
      finishedAt: "2026-07-13T12:00:02.000Z",
      failure: { code: "EXPORT_RENDER_FAILED", detail: "Renderer rejected the document" },
    }), { intervalMs: 0 })).rejects.toThrow("Renderer rejected the document");

    await expect(waitForPreviewExport({ getExportJob: vi.fn() }, exportJob({
      status: "cancelled",
      finishedAt: "2026-07-13T12:00:02.000Z",
    }), { intervalMs: 0 })).rejects.toThrow("cancelled");
  });

  it("polls a read-authorized Project Preview without using ExportJob APIs", async () => {
    const initial = projectPreview({ status: "queued" });
    const succeeded = projectPreview({ status: "succeeded", revision: 2 });
    const getProjectPreview = vi.fn().mockResolvedValue(succeeded);
    const controller = new AbortController();

    await expect(waitForProjectPreview({ getProjectPreview }, initial, {
      signal: controller.signal,
      intervalMs: 0,
      timeoutMs: 1_000,
    })).resolves.toEqual(succeeded);
    expect(getProjectPreview).toHaveBeenCalledWith(initial.id, controller.signal);
  });

  it("rejects same-origin, expired, credentialed, and non-HTTP Preview capabilities", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(validateIsolatedPreviewCapability({
      url: "https://preview.example.test/preview/token",
      expiresAt: future,
    }, "https://workbench.example.test")).toEqual({
      url: "https://preview.example.test/preview/token",
      expiresAt: future,
    });
    expect(() => validateIsolatedPreviewCapability({
      url: "https://workbench.example.test/preview/token",
      expiresAt: future,
    }, "https://workbench.example.test")).toThrow("independent");
    expect(() => validateIsolatedPreviewCapability({
      url: "https://user:password@preview.example.test/preview/token",
      expiresAt: future,
    }, "https://workbench.example.test")).toThrow("invalid");
    expect(() => validateIsolatedPreviewCapability({
      url: "data:text/html,unsafe",
      expiresAt: future,
    }, "https://workbench.example.test")).toThrow("invalid");
    expect(() => validateIsolatedPreviewCapability({
      url: "https://preview.example.test/preview/token",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }, "https://workbench.example.test")).toThrow("expired");
  });
});

function exportJob(overrides: Record<string, unknown>) {
  return {
    id: "export-1",
    releaseId: "release-1",
    createdById: "principal-1",
    format: "html" as const,
    packaging: "single_file" as const,
    selection: { kind: "artifact" as const, artifactId: "artifact-1", artifactVersionId: "version-1" },
    status: "queued" as const,
    revision: 0,
    options: {},
    output: null,
    failure: null,
    createdAt: "2026-07-13T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function projectPreview(overrides: Record<string, unknown>) {
  return {
    id: "preview-1",
    projectId: "project-1",
    boardId: "board-1",
    boardRevision: 3,
    selection: { kind: "artifact" as const, artifactId: "artifact-1", artifactVersionId: "version-1" },
    initialScreenId: "screen-home",
    status: "queued" as const,
    revision: 0,
    failure: null,
    createdAt: "2026-07-13T12:00:00.000Z",
    expiresAt: "2099-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function externalDelivery(overrides: Partial<ExternalExportDelivery>): ExternalExportDelivery {
  const timestamp = "2026-07-18T00:00:00.000Z";
  const status = overrides.status ?? "pending_confirmation";
  return {
    id: "delivery-1",
    exportJobId: "export-1",
    createdById: "principal-1",
    target: "netlify" as const,
    authentication: "authenticated" as const,
    status,
    revision: status === "cancelled" ? 1 : 0,
    attempt: 0,
    payload: {
      exportJobId: "export-1",
      releaseId: "release-1",
      format: "html" as const,
      packaging: "zip" as const,
      selection: { kind: "board" as const },
      output: {
        mediaType: "application/zip",
        byteSize: 100,
        sha256: "a".repeat(64),
        fileName: "project.zip",
      },
    },
    remoteReference: null,
    failure: null,
    createdAt: timestamp,
    confirmedAt: null,
    startedAt: null,
    transferAuthorizedAt: null,
    finishedAt: status === "cancelled" ? timestamp : null,
    updatedAt: timestamp,
    ...overrides,
  };
}

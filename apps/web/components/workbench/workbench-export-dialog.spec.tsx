// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../../lib/workbench/api/problem-details";
import { ExportDialog } from "./workbench-export-dialog";

const selection = { kind: "board_nodes" as const, nodeIds: ["node-a"] };
const available = { available: true as const, authentication: "not_required" as const, reasonCode: null };
const authRequired = { available: false as const, authentication: "required" as const, reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED" as const };
const capabilities = {
  formats: {
    html: available,
    react: available,
    figma: { available: false as const, authentication: "not_required" as const, reasonCode: "EXPORT_FIGMA_UNAVAILABLE" as const },
    mcp: available,
  },
  packaging: { single_file: available, zip: available },
  external: {
    ai_studio: { available: false as const, authentication: "not_required" as const, reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" as const },
    netlify: authRequired,
    lovable: authRequired,
    bolt: authRequired,
  },
};
const netlifyCapabilities = {
  ...capabilities,
  external: {
    ...capabilities.external,
    netlify: available,
  },
};

afterEach(cleanup);

describe("ExportDialog persisted job state", () => {
  it("restores the persisted format and downloads a succeeded Export", async () => {
    const onDownload = vi.fn(async () => undefined);
    render(<ExportDialog
      activeExport={exportJob({ format: "react", status: "succeeded" })}
      activeExportSelection={selection}
      activeExternalDelivery={null}
      busy={false}
      capabilities={capabilities}
      capabilitiesError={null}
      capabilitiesPending={false}
      error={null}
      hasSelection
      onCancelExport={vi.fn()}
      onCancelExternalDelivery={vi.fn()}
      onConfirmExternalDelivery={vi.fn()}
      onCopyCode={vi.fn()}
      onDownload={onDownload}
      onOpenChange={vi.fn()}
      onPrepareExternalDelivery={vi.fn()}
      onRetryCapabilities={vi.fn(async () => undefined)}
      onRetryExternalDelivery={vi.fn()}
      onSelectAll={vi.fn()}
      onStartExport={vi.fn()}
      open
      selection={selection}
    />);

    const download = await screen.findByRole("button", { name: "下载 React" });
    const reactTarget = screen.getByText("React").closest("button");
    await waitFor(() => expect(reactTarget?.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByText("Download .zip").closest("button")!);
    await waitFor(() => expect(screen.getByText("Download .zip").closest("button")?.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(reactTarget!);
    fireEvent.click(download);
    await waitFor(() => expect(onDownload).toHaveBeenCalledOnce());
  });

  it("cancels a restored queued Export through the existing primary action", async () => {
    const onCancelExport = vi.fn(async () => undefined);
    render(<ExportDialog
      activeExport={exportJob({ format: "html", status: "queued" })}
      activeExportSelection={selection}
      activeExternalDelivery={null}
      busy={false}
      capabilities={capabilities}
      capabilitiesError={null}
      capabilitiesPending={false}
      error={null}
      hasSelection
      onCancelExport={onCancelExport}
      onCancelExternalDelivery={vi.fn()}
      onConfirmExternalDelivery={vi.fn()}
      onCopyCode={vi.fn()}
      onDownload={vi.fn()}
      onOpenChange={vi.fn()}
      onPrepareExternalDelivery={vi.fn()}
      onRetryCapabilities={vi.fn(async () => undefined)}
      onRetryExternalDelivery={vi.fn()}
      onSelectAll={vi.fn()}
      onStartExport={vi.fn()}
      open
      selection={selection}
    />);

    fireEvent.click(screen.getByRole("button", { name: "取消导出 Copy code" }));
    await waitFor(() => expect(onCancelExport).toHaveBeenCalledOnce());
  });

  it("reports an Export capability query failure and retries the capability query", async () => {
    const onRetryCapabilities = vi.fn(async () => undefined);
    render(<ExportDialog
      activeExport={null}
      activeExportSelection={null}
      activeExternalDelivery={null}
      busy={false}
      capabilities={null}
      capabilitiesError={new Error("capabilities unavailable")}
      capabilitiesPending={false}
      error={null}
      hasSelection
      onCancelExport={vi.fn()}
      onCancelExternalDelivery={vi.fn()}
      onConfirmExternalDelivery={vi.fn()}
      onCopyCode={vi.fn()}
      onDownload={vi.fn()}
      onOpenChange={vi.fn()}
      onPrepareExternalDelivery={vi.fn()}
      onRetryCapabilities={onRetryCapabilities}
      onRetryExternalDelivery={vi.fn()}
      onSelectAll={vi.fn()}
      onStartExport={vi.fn()}
      open
      selection={selection}
    />);

    expect(screen.getAllByText("导出能力检查失败").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "导出能力检查失败，重试" }));
    await waitFor(() => expect(onRetryCapabilities).toHaveBeenCalledOnce());
  });

  it("restores the external target and immutable payload confirmation", async () => {
    const job = {
      ...exportJob({ format: "html", status: "succeeded" }),
      packaging: "zip" as const,
      output: {
        blobId: "blob-zip",
        mediaType: "application/zip",
        byteSize: 2_048,
        sha256: "b".repeat(64),
        fileName: "workbench-export.zip",
      },
    };
    render(<ExportDialog
      activeExport={job}
      activeExportSelection={selection}
      activeExternalDelivery={externalDelivery(job.id)}
      busy={false}
      capabilities={capabilities}
      capabilitiesError={null}
      capabilitiesPending={false}
      error={null}
      hasSelection
      onCancelExport={vi.fn()}
      onCancelExternalDelivery={vi.fn()}
      onConfirmExternalDelivery={vi.fn()}
      onCopyCode={vi.fn()}
      onDownload={vi.fn()}
      onOpenChange={vi.fn()}
      onPrepareExternalDelivery={vi.fn()}
      onRetryCapabilities={vi.fn(async () => undefined)}
      onRetryExternalDelivery={vi.fn()}
      onSelectAll={vi.fn()}
      onStartExport={vi.fn()}
      open
      selection={selection}
    />);

    await waitFor(() => expect(screen.getByText("Netlify").closest("button")?.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "确认发布至 Netlify" })).toBeTruthy();
    expect(screen.getByText("画布节点 1 个")).toBeTruthy();
    expect(screen.getByText("workbench-export.zip")).toBeTruthy();
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  });

  it("announces a cancellation conflict without regressing a completed delivery", async () => {
    const job = {
      ...exportJob({ format: "html", status: "succeeded" }),
      packaging: "zip" as const,
    };
    const completedDelivery = {
      ...externalDelivery(job.id),
      status: "succeeded" as const,
      revision: 3,
      remoteReference: "https://deploy.example/completed",
      confirmedAt: "2026-07-18T00:00:01.000Z",
      startedAt: "2026-07-18T00:00:02.000Z",
      transferAuthorizedAt: "2026-07-18T00:00:03.000Z",
      finishedAt: "2026-07-18T00:00:04.000Z",
      updatedAt: "2026-07-18T00:00:04.000Z",
    };
    const conflict = new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_MISMATCH",
      detail: "External Export delivery revision does not match",
    });
    const onCancelExternalDelivery = vi.fn(async () => undefined);
    render(<ExportDialog
      activeExport={job}
      activeExportSelection={selection}
      activeExternalDelivery={completedDelivery}
      busy={false}
      capabilities={netlifyCapabilities}
      capabilitiesError={null}
      capabilitiesPending={false}
      error={conflict}
      hasSelection
      onCancelExport={vi.fn()}
      onCancelExternalDelivery={onCancelExternalDelivery}
      onConfirmExternalDelivery={vi.fn()}
      onCopyCode={vi.fn()}
      onDownload={vi.fn()}
      onOpenChange={vi.fn()}
      onPrepareExternalDelivery={vi.fn()}
      onRetryCapabilities={vi.fn(async () => undefined)}
      onRetryExternalDelivery={vi.fn()}
      onSelectAll={vi.fn()}
      onStartExport={vi.fn()}
      open
      selection={selection}
    />);

    expect((await screen.findByRole("alert")).textContent)
      .toBe("发布状态已更新，本次操作未生效，请查看最新状态。");
    const revokeButton = await screen.findByRole("button", { name: "撤销发布 Netlify" });
    expect(revokeButton).toHaveProperty("disabled", false);
    fireEvent.click(revokeButton);
    await waitFor(() => expect(onCancelExternalDelivery).toHaveBeenCalledWith("Netlify"));
  });

  it("keeps the selected external target while its matching Export becomes ready", async () => {
    const onPrepareExternalDelivery = vi.fn(async () => externalDelivery("export-html"));
    const queued = {
      ...exportJob({ format: "html", status: "queued" }),
      packaging: "zip" as const,
    };
    const succeeded = {
      ...exportJob({ format: "html", status: "succeeded" }),
      packaging: "zip" as const,
    };
    const props = {
      activeExportSelection: selection,
      activeExternalDelivery: null,
      busy: false,
      capabilities: netlifyCapabilities,
      capabilitiesError: null,
      capabilitiesPending: false,
      error: null,
      hasSelection: true,
      onCancelExport: vi.fn(),
      onCancelExternalDelivery: vi.fn(),
      onConfirmExternalDelivery: vi.fn(),
      onCopyCode: vi.fn(),
      onDownload: vi.fn(),
      onOpenChange: vi.fn(),
      onPrepareExternalDelivery,
      onRetryCapabilities: vi.fn(async () => undefined),
      onRetryExternalDelivery: vi.fn(),
      onSelectAll: vi.fn(),
      onStartExport: vi.fn(),
      open: true,
      selection,
    };
    const rendered = render(<ExportDialog {...props} activeExport={null} activeExportSelection={null} />);

    fireEvent.click(screen.getByText("Netlify").closest("button")!);
    expect(screen.getByText("Netlify").closest("button")?.getAttribute("aria-pressed")).toBe("true");

    rendered.rerender(<ExportDialog {...props} activeExport={queued} />);
    await waitFor(() => expect(screen.getByText("Netlify").closest("button")?.getAttribute("aria-pressed")).toBe("true"));

    rendered.rerender(<ExportDialog {...props} activeExport={succeeded} />);
    const prepare = await screen.findByRole("button", { name: "准备发布至 Netlify" });
    fireEvent.click(prepare);
    await waitFor(() => expect(onPrepareExternalDelivery).toHaveBeenCalledWith("Netlify"));
  });
});

function exportJob({
  format,
  status,
}: {
  format: "html" | "react";
  status: "queued" | "succeeded";
}) {
  const timestamp = "2026-07-15T00:00:00.000Z";
  return {
    id: `export-${format}`,
    releaseId: "release-1",
    createdById: "principal-1",
    format,
    packaging: format === "html" ? "single_file" as const : "zip" as const,
    selection,
    status,
    revision: status === "queued" ? 0 : 2,
    options: {},
    output: status === "succeeded"
      ? {
          blobId: "blob-1",
          mediaType: format === "html" ? "text/html" : "application/zip",
          byteSize: 10,
          sha256: "a".repeat(64),
          fileName: `workbench-export-${format}`,
        }
      : null,
    failure: null,
    createdAt: timestamp,
    startedAt: status === "succeeded" ? timestamp : null,
    finishedAt: status === "succeeded" ? timestamp : null,
    updatedAt: timestamp,
  };
}

function externalDelivery(exportJobId: string) {
  const timestamp = "2026-07-18T00:00:00.000Z";
  return {
    id: "delivery-netlify",
    exportJobId,
    createdById: "principal-1",
    target: "netlify" as const,
    authentication: "authenticated" as const,
    status: "pending_confirmation" as const,
    revision: 0,
    attempt: 0,
    payload: {
      exportJobId,
      releaseId: "release-1",
      format: "html" as const,
      packaging: "zip" as const,
      selection,
      output: {
        mediaType: "application/zip",
        byteSize: 2_048,
        sha256: "b".repeat(64),
        fileName: "workbench-export.zip",
      },
    },
    remoteReference: null,
    failure: null,
    createdAt: timestamp,
    confirmedAt: null,
    startedAt: null,
    transferAuthorizedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
  };
}

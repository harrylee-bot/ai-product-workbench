// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    docx: available,
    pdf: available,
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
  it("limits source prototypes to the supported local HTML and React outputs", async () => {
    const props = documentDialogProps();
    props.onStartExport.mockResolvedValue(exportJob({ format: "react", status: "queued" }));
    const sourceSelection = { kind: "artifact" as const, artifactId: "source", artifactVersionId: "source-v1" };
    render(<ExportDialog {...props} selection={sourceSelection} sourceExport={{ source: true, reason: null }}
      capabilities={{ ...netlifyCapabilities, formats: { ...capabilities.formats, figma: available } }} />);
    for (const target of ["Figma", "MCP", "Netlify"]) {
      expect((screen.getByText(target).closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
    for (const target of ["Download .zip", "Copy code", "React"]) {
      expect((screen.getByText(target).closest("button") as HTMLButtonElement).disabled).toBe(false);
    }
    fireEvent.click(screen.getByText("React").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "导出 React" }));
    await waitFor(() => expect(props.onStartExport).toHaveBeenCalledWith("React", sourceSelection));
  });

  it("blocks source export after a selection changes to a mixed or partial application", () => {
    const props = documentDialogProps();
    const rendered = render(<ExportDialog {...props} sourceExport={{ source: true, reason: null }} />);
    fireEvent.click(screen.getByText("React").closest("button")!);
    rendered.rerender(<ExportDialog {...props} sourceExport={{ source: true, reason: "源码原型需单独导出，请只选择一个源码原型" }} />);
    const action = screen.getByRole("button", { name: "导出 React" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(action);
    expect(props.onStartExport).not.toHaveBeenCalled();
  });

  it("creates a new job for an unavailable output instead of downloading or cancelling it", async () => {
    const props = documentDialogProps();
    props.onStartExport.mockResolvedValue(exportJob({ format: "docx", status: "queued" }));
    const prdSelection = { kind: "artifact" as const, artifactId: "artifact-prd", artifactVersionId: "version-prd" };
    const job = { ...exportJob({ format: "docx", status: "succeeded" }), selection: prdSelection, status: "failed" as const, output: null, failure: { code: "EXPORT_OUTPUT_BLOB_NOT_READABLE", detail: null } };
    render(<ExportDialog {...props} activeExport={job} activeExportSelection={prdSelection}
      documentExport={{ selection: prdSelection, title: "需求文档", reason: null }} />);
    expect(await screen.findByText("文件已不可用，请重新导出。")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试导出 Download Word" }));
    await waitFor(() => expect(props.onStartExport).toHaveBeenCalledOnce());
    expect(props.onDownload).not.toHaveBeenCalled();
    expect(props.onCancelExport).not.toHaveBeenCalled();
  });

  it.each(["Download Word", "Download PDF"] as const)("starts %s with the sole PRD pin without requiring canvas selection", async (target) => {
    const prdSelection = { kind: "artifact" as const, artifactId: "artifact-prd", artifactVersionId: "version-prd" };
    const onStartExport = vi.fn(async () => exportJob({ format: "docx", status: "queued" }));
    render(<ExportDialog {...documentDialogProps()}
      documentExport={{ selection: prdSelection, title: "已生成的需求文档", reason: null }}
      hasSelection={false}
      onStartExport={onStartExport}
      selection={{ kind: "board" }}
    />);
    fireEvent.click(screen.getByText(target).closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: `导出 ${target}` }));
    await waitFor(() => expect(onStartExport).toHaveBeenCalledWith(target, prdSelection));
  });

  it("explains why a non-PRD selection cannot be exported as Word or PDF", () => {
    render(<ExportDialog {...documentDialogProps()}
      documentExport={{ selection: null, title: null, reason: "Word/PDF 仅支持完整 PRD v2 需求文档" }}
    />);
    for (const target of ["Download Word", "Download PDF"]) {
      expect((screen.getByText(target).closest("button") as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getAllByText("Word/PDF 仅支持完整 PRD v2 需求文档")).toHaveLength(2);
  });

  it("disables a previously selected document action when the current selection becomes invalid", () => {
    const props = documentDialogProps();
    const prdSelection = { kind: "artifact" as const, artifactId: "artifact-prd", artifactVersionId: "version-prd" };
    const rendered = render(<ExportDialog {...props}
      documentExport={{ selection: prdSelection, title: "PRD", reason: null }}
    />);
    fireEvent.click(screen.getByText("Download Word").closest("button")!);
    rendered.rerender(<ExportDialog {...props}
      documentExport={{ selection: null, title: null, reason: "请只选择一个 PRD 产物" }}
    />);
    const start = screen.getByRole("button", { name: "导出 Download Word" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(start);
    expect(props.onStartExport).not.toHaveBeenCalled();
  });

  it.each(["docx", "pdf"] as const)("restores a completed %s job to its download action", async (format) => {
    const onDownload = vi.fn(async () => undefined);
    const job = exportJob({ format, status: "succeeded" });
    render(<ExportDialog {...documentDialogProps()} activeExport={job} activeExportSelection={selection} onDownload={onDownload} />);
    const target = format === "docx" ? "Download Word" : "Download PDF";
    fireEvent.click(await screen.findByRole("button", { name: `下载 ${target}` }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledOnce());
  });

  it.each(["docx", "pdf"] as const)("shows a safe download error and retries the existing %s output", async (format) => {
    const user = userEvent.setup();
    const prdSelection = { kind: "artifact" as const, artifactId: "artifact-prd", artifactVersionId: "version-prd" };
    const job = { ...exportJob({ format, status: "succeeded" }), selection: prdSelection };
    let failDownload!: (error: Error) => void;
    let finishRetry!: () => void;
    const first = new Promise<void>((_resolve, reject) => { failDownload = reject; });
    const retry = new Promise<void>((resolve) => { finishRetry = resolve; });
    const download = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(retry);
    const onStartExport = vi.fn();

    function DownloadHarness() {
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState<unknown>(null);
      return <ExportDialog {...documentDialogProps()}
        activeExport={job}
        activeExportSelection={prdSelection}
        busy={busy}
        documentExport={{ selection: prdSelection, title: "已生成的需求文档", reason: null }}
        error={error}
        hasSelection={false}
        onDownload={async () => {
          setError(null);
          setBusy(true);
          try {
            await download(job.id);
          } catch (failure) {
            setError(failure);
            throw failure;
          } finally {
            setBusy(false);
          }
        }}
        onStartExport={onStartExport}
        selection={{ kind: "board" }}
      />;
    }

    const rendered = render(<DownloadHarness />);
    const target = format === "docx" ? "Download Word" : "Download PDF";
    await user.click(await screen.findByRole("button", { name: `下载 ${target}` }));
    const downloading = screen.getByRole("button", { name: "正在下载文件..." });
    expect((downloading as HTMLButtonElement).disabled).toBe(true);
    expect(downloading.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      failDownload(new Error("HTTP 403 https://internal.example.test/content?token=private-token AccessDenied"));
    });
    expect((await screen.findByRole("alert")).textContent).toBe("文件下载失败，请重试。");
    for (const detail of ["403", "https://", "private-token", "AccessDenied"]) {
      expect(rendered.container.textContent).not.toContain(detail);
    }

    await user.click(screen.getByRole("button", { name: "重试下载文件" }));
    expect(screen.getByRole("button", { name: "正在下载文件..." })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(download.mock.calls).toEqual([[job.id], [job.id]]);
    expect(onStartExport).not.toHaveBeenCalled();

    await act(async () => { finishRetry(); });
    const downloaded = await screen.findByRole("button", { name: `下载 ${target}` });
    expect((downloaded as HTMLButtonElement).disabled).toBe(false);
    expect(downloaded.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onStartExport).not.toHaveBeenCalled();
  });

  it("creates a new export when the PRD pin changes after an earlier download error", async () => {
    const user = userEvent.setup();
    const originalSelection = { kind: "artifact" as const, artifactId: "artifact-prd", artifactVersionId: "version-1" };
    const currentSelection = { ...originalSelection, artifactVersionId: "version-2" };
    const onDownload = vi.fn();
    const onStartExport = vi.fn(async () => exportJob({ format: "docx", status: "queued" }));
    const props = {
      ...documentDialogProps(),
      activeExport: { ...exportJob({ format: "docx", status: "succeeded" }), selection: originalSelection },
      activeExportSelection: originalSelection,
      error: new Error("previous download failed"),
      onDownload,
      onStartExport,
    };
    const rendered = render(<ExportDialog {...props}
      documentExport={{ selection: originalSelection, title: "原需求文档", reason: null }}
    />);
    await screen.findByRole("button", { name: "重试下载文件" });
    rendered.rerender(<ExportDialog {...props}
      documentExport={{ selection: currentSelection, title: "新版需求文档", reason: null }}
    />);

    await user.click(await screen.findByRole("button", { name: "重试导出 Download Word" }));
    expect(onStartExport).toHaveBeenCalledWith("Download Word", currentSelection);
    expect(onDownload).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

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
  format: "html" | "react" | "docx" | "pdf";
  status: "queued" | "succeeded";
}) {
  const timestamp = "2026-07-15T00:00:00.000Z";
  return {
    id: `export-${format}`,
    releaseId: "release-1",
    createdById: "principal-1",
    format,
    packaging: format === "react" ? "zip" as const : "single_file" as const,
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

function documentDialogProps() {
  return {
    activeExport: null,
    activeExportSelection: null,
    activeExternalDelivery: null,
    busy: false,
    capabilities,
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
    onPrepareExternalDelivery: vi.fn(),
    onRetryCapabilities: vi.fn(async () => undefined),
    onRetryExternalDelivery: vi.fn(),
    onSelectAll: vi.fn(),
    onStartExport: vi.fn(),
    open: true,
    selection,
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

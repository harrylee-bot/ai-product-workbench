// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorkbenchUploadItemViewModel } from "@/lib/workbench/files/upload-registry";

import { WorkbenchUploadList } from "./workbench-upload-list";

describe("WorkbenchUploadList", () => {
  it("renders every file and delegates controls by registry id", () => {
    const onCancel = vi.fn(async () => undefined);
    const onPause = vi.fn(() => true);
    const onResume = vi.fn(() => true);
    const onRetry = vi.fn(async () => undefined);

    renderWithTooltips(
      <WorkbenchUploadList
        onCancel={onCancel}
        onPause={onPause}
        onResume={onResume}
        onRetry={onRetry}
        placement="project"
        uploads={[
          uploadViewModel({ id: "upload-a", fileName: "brief.pdf", phase: "uploading", canPause: true }),
          uploadViewModel({
            id: "upload-b",
            fileName: "wireframe.png",
            phase: "failed",
            stage: "failed",
            statusLabel: "处理失败",
            canRetry: true,
            error: { code: "UPLOAD_FAILED", message: "连接中断", retryable: true },
          }),
        ]}
      />,
    );

    expect(screen.getByText("brief.pdf")).toBeTruthy();
    expect(screen.getByText("wireframe.png")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "暂停上传 brief.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "取消上传 brief.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "重试上传 wireframe.png" }));

    expect(onPause).toHaveBeenCalledWith("upload-a");
    expect(onCancel).toHaveBeenCalledWith("upload-a");
    expect(onRetry).toHaveBeenCalledWith("upload-b");
  });

  it("shows resume for a paused file and no destructive control after commit", () => {
    const onResume = vi.fn(() => true);
    renderWithTooltips(
      <WorkbenchUploadList
        onCancel={vi.fn(async () => undefined)}
        onPause={vi.fn(() => true)}
        onResume={onResume}
        onRetry={vi.fn(async () => undefined)}
        placement="home"
        uploads={[
          uploadViewModel({
            id: "upload-paused",
            fileName: "research.docx",
            phase: "paused",
            statusLabel: "上传已暂停",
            canResume: true,
          }),
          uploadViewModel({
            id: "upload-ready",
            fileName: "logo.png",
            phase: "ready",
            stage: "ready",
            statusLabel: "文件已就绪",
            progress: 100,
            canCancel: false,
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "继续上传 research.docx" }));
    expect(onResume).toHaveBeenCalledWith("upload-paused");
    expect(screen.queryByRole("button", { name: "取消上传 logo.png" })).toBeNull();
  });

  it("reuses the file panel for durable submission recovery", () => {
    const onCancelRecovery = vi.fn(async () => undefined);
    const onSelectRecoveryFiles = vi.fn<(files: FileList) => Promise<void>>(
      async () => undefined,
    );
    const rendered = renderWithTooltips(
      <WorkbenchUploadList
        onCancel={vi.fn(async () => undefined)}
        onCancelRecovery={onCancelRecovery}
        onPause={vi.fn(() => true)}
        onResume={vi.fn(() => true)}
        onRetry={vi.fn(async () => undefined)}
        onSelectRecoveryFiles={onSelectRecoveryFiles}
        placement="project"
        recovery={{
          actionPending: false,
          cancellable: true,
          error: null,
          files: [{ byteSize: 1_024, fileName: "brief.pdf", position: 0 }],
          kind: "waiting_files",
          message: "请重新选择 1 个原附件",
          retryable: false,
        }}
        uploads={[]}
      />,
    );

    expect(within(rendered.container).getByText("恢复未完成的提交")).toBeTruthy();
    expect(within(rendered.container).getByText("brief.pdf")).toBeTruthy();
    fireEvent.click(within(rendered.container).getByRole("button", { name: "取消未完成的提交" }));
    expect(onCancelRecovery).toHaveBeenCalledOnce();

    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("missing recovery file input");
    const file = new File([new Uint8Array([1])], "brief.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onSelectRecoveryFiles).toHaveBeenCalledOnce();
    expect(onSelectRecoveryFiles.mock.calls[0]?.[0]?.[0]).toBe(file);
  });
});

function uploadViewModel(
  patch: Partial<WorkbenchUploadItemViewModel>,
): WorkbenchUploadItemViewModel {
  return {
    id: "upload-1",
    controllerId: "controller-1",
    projectId: "project-1",
    fileName: "brief.pdf",
    byteSize: 1_024,
    phase: "uploading",
    stage: "upload",
    statusLabel: "正在上传",
    progress: 52,
    hashPercent: 100,
    uploadPercent: 50,
    error: null,
    submissionIntentId: null,
    actionPending: null,
    canPause: false,
    canResume: false,
    canCancel: true,
    canRetry: false,
    ...patch,
  };
}

function renderWithTooltips(children: ReactNode) {
  return render(<TooltipProvider>{children}</TooltipProvider>);
}

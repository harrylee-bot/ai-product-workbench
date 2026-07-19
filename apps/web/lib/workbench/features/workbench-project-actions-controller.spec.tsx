// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkbenchProjectActionsController } from "./workbench-project-actions-controller";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

beforeEach(() => {
  mocks.toastError.mockReset();
});

describe("Workbench Project actions controller", () => {
  it("fences duplicate requests synchronously and preserves the existing failure toast", async () => {
    const duplicate = deferred<unknown>();
    const onDuplicateProject = vi.fn(() => duplicate.promise);
    const rendered = renderController({ onDuplicateProject });

    act(() => {
      expect(rendered.result.current.duplicateProject()).toBe(true);
      expect(rendered.result.current.duplicateProject()).toBe(false);
    });
    expect(onDuplicateProject).toHaveBeenCalledOnce();
    expect(rendered.result.current.projectActionBusy).toBe(true);

    await act(async () => {
      duplicate.reject(new Error("duplicate failed"));
      await duplicate.promise.catch(() => undefined);
    });
    await waitFor(() => expect(rendered.result.current.projectActionBusy).toBe(false));
    expect(mocks.toastError).toHaveBeenCalledWith("复制项目失败，请重试");
  });

  it("keeps a failed archive confirmation open and resets the failure on a new request", async () => {
    const archive = deferred<unknown>();
    const onArchiveProject = vi.fn(() => archive.promise);
    const onArchived = vi.fn();
    const rendered = renderController({ onArchiveProject, onArchived });

    act(() => rendered.result.current.requestArchiveProject());
    expect(rendered.result.current.archiveConfirmationOpen).toBe(true);
    act(() => {
      expect(rendered.result.current.confirmArchiveProject()).toBe(true);
      expect(rendered.result.current.confirmArchiveProject()).toBe(false);
    });
    expect(onArchiveProject).toHaveBeenCalledOnce();
    expect(rendered.result.current.projectActionBusy).toBe(true);

    await act(async () => {
      archive.reject(new Error("archive failed"));
      await archive.promise.catch(() => undefined);
    });
    await waitFor(() => expect(rendered.result.current.projectActionBusy).toBe(false));
    expect(rendered.result.current.archiveConfirmationOpen).toBe(true);
    expect(rendered.result.current.archiveFailed).toBe(true);
    expect(onArchived).not.toHaveBeenCalled();

    act(() => rendered.result.current.requestArchiveProject());
    expect(rendered.result.current.archiveFailed).toBe(false);
  });

  it("closes a successful archive before handing navigation back to the shell", async () => {
    const archive = deferred<unknown>();
    const calls: string[] = [];
    const rendered = renderController({
      onArchiveProject: vi.fn(() => {
        calls.push("archive");
        return archive.promise;
      }),
      onArchived: vi.fn(() => calls.push("navigate")),
    });
    act(() => rendered.result.current.requestArchiveProject());
    act(() => {
      rendered.result.current.confirmArchiveProject();
    });

    await act(async () => {
      archive.resolve(undefined);
      await archive.promise;
    });

    expect(calls).toEqual(["archive", "navigate"]);
    expect(rendered.result.current.archiveConfirmationOpen).toBe(false);
    expect(rendered.result.current.archiveFailed).toBe(false);
    expect(rendered.result.current.projectActionBusy).toBe(false);
  });

  it("keeps permission gates and rename dialog state inside the controller", () => {
    const onArchiveProject = vi.fn(async () => undefined);
    const onDuplicateProject = vi.fn(async () => undefined);
    const blocked = renderController({
      canArchive: false,
      canDuplicate: false,
      canRename: false,
      onArchiveProject,
      onDuplicateProject,
    });

    act(() => blocked.result.current.requestArchiveProject());
    expect(blocked.result.current.archiveConfirmationOpen).toBe(true);
    expect(blocked.result.current.confirmArchiveProject()).toBe(false);
    expect(blocked.result.current.duplicateProject()).toBe(false);
    expect(blocked.result.current.requestRenameProject()).toBe(false);
    expect(onArchiveProject).not.toHaveBeenCalled();
    expect(onDuplicateProject).not.toHaveBeenCalled();
    expect(blocked.result.current.renameOpen).toBe(false);

    const allowed = renderController();
    act(() => {
      expect(allowed.result.current.requestRenameProject()).toBe(true);
    });
    expect(allowed.result.current.renameOpen).toBe(true);
    act(() => allowed.result.current.closeRenameProject());
    expect(allowed.result.current.renameOpen).toBe(false);
  });

  it("drops a previous Project operation without clearing the new Project's busy state or navigating", async () => {
    const projectOneArchive = deferred<unknown>();
    const projectTwoDuplicate = deferred<unknown>();
    const projectOneArchived = vi.fn();
    const projectTwoArchived = vi.fn();
    const rendered = renderHook(
      ({ onArchiveProject, onArchived, onDuplicateProject, projectId }) => (
        useWorkbenchProjectActionsController({
          canArchive: true,
          canDuplicate: true,
          canRename: true,
          onArchiveProject,
          onArchived,
          onDuplicateProject,
          onRenameProject: vi.fn(async () => undefined),
          projectId,
        })
      ),
      {
        initialProps: {
          onArchiveProject: vi.fn<() => Promise<unknown>>(() => projectOneArchive.promise),
          onArchived: projectOneArchived,
          onDuplicateProject: vi.fn<() => Promise<unknown>>(async () => undefined),
          projectId: "project-1",
        },
      },
    );

    act(() => rendered.result.current.requestArchiveProject());
    act(() => expect(rendered.result.current.confirmArchiveProject()).toBe(true));
    expect(rendered.result.current.projectActionBusy).toBe(true);

    rendered.rerender({
      onArchiveProject: vi.fn(async () => undefined),
      onArchived: projectTwoArchived,
      onDuplicateProject: vi.fn(() => projectTwoDuplicate.promise),
      projectId: "project-2",
    });
    expect(rendered.result.current.archiveConfirmationOpen).toBe(false);
    expect(rendered.result.current.archiveFailed).toBe(false);
    expect(rendered.result.current.projectActionBusy).toBe(false);

    act(() => expect(rendered.result.current.duplicateProject()).toBe(true));
    expect(rendered.result.current.projectActionBusy).toBe(true);

    await act(async () => {
      projectOneArchive.reject(new Error("late project-1 archive failure"));
      await projectOneArchive.promise.catch(() => undefined);
    });
    expect(rendered.result.current.projectActionBusy).toBe(true);
    expect(rendered.result.current.archiveFailed).toBe(false);
    expect(projectOneArchived).not.toHaveBeenCalled();
    expect(projectTwoArchived).not.toHaveBeenCalled();

    await act(async () => {
      projectTwoDuplicate.resolve(undefined);
      await projectTwoDuplicate.promise;
    });
    expect(rendered.result.current.projectActionBusy).toBe(false);
  });
});

function renderController({
  canArchive = true,
  canDuplicate = true,
  canRename = true,
  onArchiveProject = vi.fn(async () => undefined),
  onArchived = vi.fn(),
  onDuplicateProject = vi.fn(async () => undefined),
  onRenameProject = vi.fn(async () => undefined),
  projectId = "project-1",
}: Partial<Parameters<typeof useWorkbenchProjectActionsController>[0]> = {}) {
  return renderHook(() => useWorkbenchProjectActionsController({
    canArchive,
    canDuplicate,
    canRename,
    onArchiveProject,
    onArchived,
    onDuplicateProject,
    onRenameProject,
    projectId,
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

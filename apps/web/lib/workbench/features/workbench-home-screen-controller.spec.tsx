// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "../api/problem-details";
import type { WorkbenchHomeProjectItem } from "./projects";
import { useWorkbenchHomeScreenController } from "./workbench-home-screen-controller";

const mocks = vi.hoisted(() => ({
  getCommunicationPreferences: vi.fn(),
  toastError: vi.fn(),
  updateCommunicationPreferences: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("./identity/api-adapter", () => ({
  useWorkbenchIdentityApi: () => mocks,
}));

beforeEach(() => {
  mocks.getCommunicationPreferences.mockReset();
  mocks.toastError.mockReset();
  mocks.updateCommunicationPreferences.mockReset();
  mocks.getCommunicationPreferences.mockResolvedValue(versioned(false, false, 0, '"0"'));
  mocks.updateCommunicationPreferences.mockResolvedValue(versioned(true, false, 1, '"1"'));
});

describe("Workbench Home screen controller", () => {
  it("hydrates communication preferences before allowing an ETag-backed write", async () => {
    const hydration = deferred<ReturnType<typeof versioned>>();
    mocks.getCommunicationPreferences.mockReturnValue(hydration.promise);
    mocks.updateCommunicationPreferences.mockResolvedValue(versioned(true, true, 4, '"4"'));
    const rendered = renderController();

    expect(rendered.result.current.communicationPreferences).toBeNull();
    expect(rendered.result.current.communicationPreferencesBusy).toBe(true);
    act(() => {
      rendered.result.current.saveCommunicationPreferences({ productUpdatesEmail: true });
    });
    expect(mocks.updateCommunicationPreferences).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("通信偏好尚未就绪，请重试");

    await act(async () => {
      hydration.resolve(versioned(false, true, 3, '"3"'));
      await hydration.promise;
    });
    await waitFor(() => expect(rendered.result.current.communicationPreferences).toMatchObject({
      productUpdatesEmail: false,
      researchInvitations: true,
      revision: 3,
    }));

    act(() => {
      rendered.result.current.saveCommunicationPreferences({ productUpdatesEmail: true });
    });
    await waitFor(() => expect(mocks.updateCommunicationPreferences).toHaveBeenCalledWith(
      { productUpdatesEmail: true, researchInvitations: true },
      '"3"',
    ));
    await waitFor(() => expect(rendered.result.current.communicationPreferences).toMatchObject({
      productUpdatesEmail: true,
      researchInvitations: true,
      revision: 4,
    }));

    rendered.unmount();
    rendered.queryClient.clear();
  });

  it("keeps the hydrated value and refetches the authoritative revision after a CAS failure", async () => {
    const initial = versioned(false, false, 4, '"4"');
    const refreshed = versioned(false, true, 5, '"5"');
    mocks.getCommunicationPreferences
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    mocks.updateCommunicationPreferences.mockRejectedValue(new WorkbenchApiError({
      type: "about:blank",
      title: "Precondition failed",
      status: 412,
      code: "REVISION_MISMATCH",
    }));
    const rendered = renderController();
    await waitFor(() => expect(rendered.result.current.communicationPreferences?.revision).toBe(4));

    act(() => {
      rendered.result.current.saveCommunicationPreferences({ productUpdatesEmail: true });
    });

    await waitFor(() => expect(mocks.updateCommunicationPreferences).toHaveBeenCalledWith(
      { productUpdatesEmail: true, researchInvitations: false },
      '"4"',
    ));
    await waitFor(() => expect(mocks.getCommunicationPreferences).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rendered.result.current.communicationPreferences).toEqual(refreshed.value));
    expect(mocks.toastError).toHaveBeenCalledWith("通信偏好保存失败，请重试");

    rendered.unmount();
    rendered.queryClient.clear();
  });

  it("fences duplicate actions synchronously and releases busy state after an error", async () => {
    const duplicate = deferred<unknown>();
    const onDuplicateProject = vi.fn(() => duplicate.promise);
    const rendered = renderController({ onDuplicateProject });
    const project = homeProject("project-duplicate");

    act(() => {
      rendered.result.current.duplicateProject(project);
      rendered.result.current.duplicateProject(project);
    });
    expect(onDuplicateProject).toHaveBeenCalledOnce();
    expect(onDuplicateProject).toHaveBeenCalledWith("project-duplicate");
    expect(rendered.result.current.projectActionBusy).toBe(true);

    await act(async () => {
      duplicate.reject(new Error("duplicate failed"));
      await duplicate.promise.catch(() => undefined);
    });
    await waitFor(() => expect(rendered.result.current.projectActionBusy).toBe(false));
    expect(mocks.toastError).toHaveBeenCalledWith("复制项目失败，请重试");

    rendered.unmount();
    rendered.queryClient.clear();
  });

  it("fences archive confirmation and keeps the target open with an inline failure state", async () => {
    const archive = deferred<unknown>();
    const onArchiveProject = vi.fn(() => archive.promise);
    const rendered = renderController({ onArchiveProject });
    const project = homeProject("project-archive");

    act(() => rendered.result.current.requestArchiveProject(project));
    expect(rendered.result.current.archiveProjectTarget).toEqual(project);

    act(() => {
      rendered.result.current.confirmArchiveProject();
      rendered.result.current.confirmArchiveProject();
    });
    expect(onArchiveProject).toHaveBeenCalledOnce();
    expect(onArchiveProject).toHaveBeenCalledWith("project-archive");
    expect(rendered.result.current.projectActionBusy).toBe(true);

    act(() => rendered.result.current.onArchiveDialogOpenChange(false));
    expect(rendered.result.current.archiveProjectTarget).toEqual(project);

    await act(async () => {
      archive.reject(new Error("archive failed"));
      await archive.promise.catch(() => undefined);
    });
    await waitFor(() => expect(rendered.result.current.projectActionBusy).toBe(false));
    expect(rendered.result.current.archiveFailed).toBe(true);
    expect(rendered.result.current.archiveProjectTarget).toEqual(project);

    rendered.unmount();
    rendered.queryClient.clear();
  });

  it("normalizes the model and keeps menu and mobile-panel transitions in the controller", async () => {
    const rendered = renderController();
    await waitFor(() => expect(rendered.result.current.homeModel).toBe("model:quality"));

    act(() => rendered.result.current.toggleHomeStyleMenu());
    expect(rendered.result.current.homeStyleMenuOpen).toBe(true);
    act(() => rendered.result.current.toggleHomeModelMenu());
    expect(rendered.result.current.homeStyleMenuOpen).toBe(false);
    expect(rendered.result.current.homeModelMenuOpen).toBe(true);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(rendered.result.current.homeModelMenuOpen).toBe(false);
    act(() => rendered.result.current.toggleMobileProjects());
    expect(rendered.result.current.mobileProjectsOpen).toBe(true);

    rendered.unmount();
    rendered.queryClient.clear();
  });
});

function renderController({
  onArchiveProject = vi.fn(async () => undefined),
  onDuplicateProject = vi.fn(async () => undefined),
}: {
  onArchiveProject?: (projectId: string) => Promise<unknown>;
  onDuplicateProject?: (projectId: string) => Promise<unknown>;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(() => useWorkbenchHomeScreenController({
    modelCatalogStatus: "ready",
    modelChoices: [{
      description: "Quality model",
      key: "model:quality",
      label: "Quality",
      modelId: "quality",
      workflow: "generate",
    }],
    onArchiveProject,
    onDuplicateProject,
  }), { wrapper });
  return { ...rendered, queryClient };
}

function homeProject(id: string): WorkbenchHomeProjectItem {
  return {
    id,
    accent: "#7467f6",
    date: "Jul 14, 2026",
    group: "最近",
    revision: 1,
    role: "owner",
    shared: false,
    title: "Project",
    variant: "dark",
  };
}

function versioned(
  productUpdatesEmail: boolean,
  researchInvitations: boolean,
  revision: number,
  etag: string,
) {
  return {
    value: {
      productUpdatesEmail,
      researchInvitations,
      revision,
      createdAt: revision === 0 ? null : "2026-07-14T08:30:00.000Z",
      updatedAt: revision === 0 ? null : "2026-07-14T08:30:00.000Z",
    },
    etag,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

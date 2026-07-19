// @vitest-environment jsdom

import type { ImportSource } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchImportSourcesDialog } from "./workbench-import-sources-dialog";

const mocks = vi.hoisted(() => ({
  createImportSource: vi.fn(),
  deleteImportSource: vi.fn(),
  getImportSource: vi.fn(),
  listImportSources: vi.fn(),
}));

vi.mock("@/lib/workbench/features/import-sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workbench/features/import-sources")>("@/lib/workbench/features/import-sources");
  return {
    ...actual,
    useOptionalWorkbenchImportSourcesApi: () => mocks,
  };
});

vi.mock("@/lib/workbench/features/import-sources/api-adapter", () => ({
  useOptionalWorkbenchImportSourcesApi: () => mocks,
}));

const timestamp = "2026-07-18T00:00:00.000Z";

function source(overrides: Partial<ImportSource>): ImportSource {
  return {
    id: "source-1",
    projectId: "project-1",
    createdById: "user-1",
    kind: "url_snapshot",
    status: "pending",
    label: "Example",
    descriptor: null,
    checksum: null,
    revision: 0,
    failure: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Workbench Import Sources dialog", () => {
  it("renders real lifecycle statuses and only enables ready selection", async () => {
    const ready = source({ id: "source-ready", status: "ready", label: "Ready site", checksum: "a".repeat(64), revision: 1, descriptor: { kind: "url_snapshot", sourceUrl: "https://example.com", resolvedUrl: "https://example.com" } });
    const failed = source({ id: "source-failed", status: "failed", label: "Broken site", failure: { code: "FETCH_FAILED", message: "源站拒绝访问" }, revision: 2 });
    mocks.listImportSources.mockResolvedValue({ items: [ready, source({}), failed], nextCursor: null });
    const onSelected = vi.fn();
    renderDialog({ onSelectedSourceIdsChange: onSelected });

    await waitFor(() => expect(screen.getByText("Ready site")).toBeTruthy());
    expect(screen.getByText("可用")).toBeTruthy();
    expect(screen.getByText("处理中")).toBeTruthy();
    expect(screen.getByText("导入失败")).toBeTruthy();
    const readyButton = screen.getByRole("button", { name: "选择Ready site" });
    const pendingButton = screen.getByRole("button", { name: "Example暂不可用" });
    expect((readyButton as HTMLButtonElement).disabled).toBe(false);
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(readyButton);
    expect(onSelected).toHaveBeenCalledWith(["source-ready"]);
  });

  it("validates external locators before creating a source", async () => {
    const createExternalSource = vi.fn(async (request) => source({
      id: "source-new",
      kind: request.kind,
      status: "pending",
      label: request.label ?? "example.com",
    }));
    renderDialog({ createExternalSource, projectId: "" });
    fireEvent.click(screen.getByRole("button", { name: "网站网址" }));
    const urlInput = await screen.findByPlaceholderText("https://example.com");
    fireEvent.change(urlInput, {
      target: { value: "http://127.0.0.1:3000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
    expect(createExternalSource).not.toHaveBeenCalled();

    fireEvent.change(urlInput, {
      target: { value: "https://example.com/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加来源" }));
    await waitFor(() => expect(createExternalSource).toHaveBeenCalledWith({
      kind: "url_snapshot",
      sourceUrl: "https://example.com/docs",
    }));
  });

  it("does not prune selected sources before the authoritative list loads", async () => {
    let resolveList!: (value: { items: ImportSource[]; nextCursor: null }) => void;
    mocks.listImportSources.mockReturnValue(new Promise((resolve) => {
      resolveList = resolve;
    }));
    const onSelected = vi.fn();

    renderDialog({
      onSelectedSourceIdsChange: onSelected,
      selectedSourceIds: ["source-ready"],
    });

    await waitFor(() => expect(mocks.listImportSources).toHaveBeenCalledWith("project-1", {}));
    expect(onSelected).not.toHaveBeenCalled();
    await act(async () => resolveList({
      items: [source({
        id: "source-ready",
        status: "ready",
        checksum: "a".repeat(64),
        descriptor: {
          kind: "url_snapshot",
          sourceUrl: "https://example.com",
          resolvedUrl: "https://example.com",
        },
      })],
      nextCursor: null,
    }));
    await waitFor(() => expect(screen.getByText("可用")).toBeTruthy());
    expect(onSelected).not.toHaveBeenCalled();
  });

  it("locks an external create command until the owning Project flow settles", async () => {
    let resolveCreate!: (value: ImportSource) => void;
    const createExternalSource = vi.fn(() => new Promise<ImportSource>((resolve) => {
      resolveCreate = resolve;
    }));
    renderDialog({ createExternalSource, projectId: "" });
    fireEvent.click(screen.getByRole("button", { name: "网站网址" }));
    fireEvent.change(await screen.findByPlaceholderText("https://example.com"), {
      target: { value: "https://example.com/docs" },
    });
    const createButton = screen.getByRole("button", { name: "添加来源" }) as HTMLButtonElement;

    fireEvent.click(createButton);
    fireEvent.click(createButton);

    await waitFor(() => expect(createExternalSource).toHaveBeenCalledOnce());
    expect(createButton.disabled).toBe(true);
    await act(async () => resolveCreate(source({ id: "source-new" })));
    await waitFor(() => expect(createButton.disabled).toBe(false));
  });
});

function renderDialog({
  createExternalSource,
  onSelectedSourceIdsChange = vi.fn(),
  projectId = "project-1",
  selectedSourceIds = [],
}: {
  createExternalSource?: (request: Parameters<NonNullable<ComponentProps<typeof WorkbenchImportSourcesDialog>["onCreateExternalSource"]>>[0]) => Promise<ImportSource | null>;
  onSelectedSourceIdsChange?: (sourceIds: string[]) => void;
  projectId?: string;
  selectedSourceIds?: string[];
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WorkbenchImportSourcesDialog
        onCreateExternalSource={createExternalSource}
        onOpenChange={vi.fn()}
        onSelectFiles={vi.fn()}
        onSelectedSourceIdsChange={onSelectedSourceIdsChange}
        open
        projectId={projectId}
        selectedSourceIds={selectedSourceIds}
      />
    </QueryClientProvider>,
  );
}

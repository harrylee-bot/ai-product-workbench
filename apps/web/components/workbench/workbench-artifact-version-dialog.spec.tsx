// @vitest-environment jsdom

import type { ArtifactVersionDetail, ArtifactVersionListItem } from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prdDocument } from "./workbench-prd-test-fixture";
import { WorkbenchArtifactVersionDialog } from "./workbench-artifact-version-dialog";

const mocks = vi.hoisted(() => ({
  artifact: vi.fn(),
  artifactContent: vi.fn(),
  artifactVersion: vi.fn(),
  artifactVersions: vi.fn(),
}));

vi.mock("@/lib/workbench/features", () => ({
  useInfiniteWorkbenchArtifactVersions: mocks.artifactVersions,
  useWorkbenchArtifact: mocks.artifact,
  useWorkbenchArtifactVersion: mocks.artifactVersion,
  useWorkbenchArtifactVersionContent: mocks.artifactContent,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => (
    open ? <>{children}</> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./workbench-artifact-content", () => ({
  WorkbenchArtifactContent: ({ reference }: { reference: { artifactVersionId: string } }) => (
    <div>preview:{reference.artifactVersionId}</div>
  ),
}));

vi.mock("./workbench-artifact-version-merge", () => ({
  WorkbenchArtifactVersionMerge: ({ after, before }: { after: string; before: string }) => (
    <pre aria-label="版本内容比较" role="region">{before}{"\n---\n"}{after}</pre>
  ),
}));

beforeEach(() => {
  const versionQueries = new Map([
    ["version-1", query({ value: prdVersion("version-1", 1) })],
    ["version-2", query({ value: prdVersion("version-2", 2) })],
  ]);
  mocks.artifact.mockReset().mockReturnValue(query({
    value: { currentVersion: { artifactVersionId: "version-2" } },
  }));
  mocks.artifactContent.mockReset().mockReturnValue(query(undefined));
  mocks.artifactVersions.mockReset().mockReturnValue(infiniteQuery([{
    items: [versionListItem("version-2", 2), versionListItem("version-1", 1)],
    nextCursor: null,
  }]));
  mocks.artifactVersion.mockReset().mockImplementation((
    _projectId: string,
    _artifactId: string,
    versionId: string,
  ) => versionQueries.get(versionId) ?? query(undefined));
});

afterEach(() => cleanup());

describe("Workbench ArtifactVersion dialog", () => {
  it("previews history without changing the Board, compares it, then pins through the command", async () => {
    const onPinVersion = vi.fn(async () => undefined);
    render(
      <WorkbenchArtifactVersionDialog
        canPin
        onOpenChange={vi.fn()}
        onPinVersion={onPinVersion}
        open
        reference={{
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "version-2",
        }}
      />,
    );

    expect(screen.getByText(/画布固定在 v2/)).not.toBeNull();
    expect(screen.getByText("preview:version-2")).not.toBeNull();
    expect(mocks.artifactVersions).toHaveBeenCalledWith(
      "project-1",
      "artifact-1",
      { limit: 100 },
    );

    fireEvent.click(screen.getByRole("button", { name: /v1/ }));
    expect(await screen.findByText("preview:version-1")).not.toBeNull();
    expect(onPinVersion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "比较" }));
    const comparison = await screen.findByRole("region", { name: "版本内容比较" });
    expect(comparison.textContent).toContain("Revision: 2");
    expect(comparison.textContent).toContain("Revision: 1");

    fireEvent.click(screen.getByRole("button", { name: "固定到画布" }));
    await waitFor(() => expect(onPinVersion).toHaveBeenCalledWith(
      "artifact-1",
      "version-2",
      "version-1",
    ));
  });

  it("renders an explicit empty state and disables pinning", () => {
    mocks.artifactVersions.mockReturnValue(infiniteQuery([{ items: [], nextCursor: null }]));
    render(
      <WorkbenchArtifactVersionDialog
        canPin
        onOpenChange={vi.fn()}
        onPinVersion={vi.fn()}
        open
        reference={{
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "version-2",
        }}
      />,
    );

    expect(screen.getByText("暂无版本记录")).not.toBeNull();
    expect((screen.getByRole("button", { name: "固定到画布" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps an older pinned version visible when the recent page is truncated", () => {
    mocks.artifactVersions.mockReturnValue(infiniteQuery([{
      items: [versionListItem("version-2", 2)],
      nextCursor: "older-versions",
    }]));
    render(
      <WorkbenchArtifactVersionDialog
        canPin
        onOpenChange={vi.fn()}
        onPinVersion={vi.fn()}
        open
        reference={{
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
        }}
      />,
    );

    expect(screen.getByRole("button", { name: /v1.*画布/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "加载更早版本（另含画布固定版本）" })).not.toBeNull();
  });

  it("loads every older page through the persisted cursor", async () => {
    const fetchNextPage = vi.fn();
    mocks.artifactVersions.mockReturnValue(infiniteQuery([{
      items: [versionListItem("version-2", 2)],
      nextCursor: "older-versions",
    }], { fetchNextPage }));
    render(
      <WorkbenchArtifactVersionDialog
        canPin
        onOpenChange={vi.fn()}
        onPinVersion={vi.fn()}
        open
        reference={{
          projectId: "project-1",
          artifactId: "artifact-1",
          artifactVersionId: "version-2",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更早版本" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

function query<T>(data: T) {
  return {
    data,
    error: null,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  };
}

function infiniteQuery<T extends { nextCursor: string | null }>(
  pages: T[],
  overrides: Record<string, unknown> = {},
) {
  return {
    data: { pages, pageParams: [undefined] },
    error: null,
    fetchNextPage: vi.fn(),
    hasNextPage: pages.at(-1)?.nextCursor !== null,
    isError: false,
    isFetchingNextPage: false,
    isPending: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function versionListItem(artifactVersionId: string, version: number): ArtifactVersionListItem {
  return {
    artifactId: "artifact-1",
    artifactVersionId,
    version,
    kind: "prd",
    schemaVersion: 1,
    status: "ready",
    checksum: String(version).repeat(64).slice(0, 64),
    createdByRunId: null,
    createdAt: `2026-07-${String(10 + version).padStart(2, "0")}T00:00:00.000Z`,
    contentMode: "inline",
  };
}

function prdVersion(artifactVersionId: string, version: number): ArtifactVersionDetail {
  const document = prdDocument();
  return {
    artifactId: "artifact-1",
    artifactVersionId,
    version,
    kind: "prd",
    schemaVersion: 1,
    status: "ready",
    checksum: String(version).repeat(64).slice(0, 64),
    citations: [],
    createdByRunId: null,
    knowledgeReleaseId: null,
    createdAt: `2026-07-${String(10 + version).padStart(2, "0")}T00:00:00.000Z`,
    contentMode: "inline",
    content: {
      ...document,
      revision: { ...document.revision, number: version },
    },
  };
}

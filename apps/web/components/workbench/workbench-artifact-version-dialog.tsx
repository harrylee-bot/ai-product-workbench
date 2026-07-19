"use client";

import type { ArtifactVersionDetail, ArtifactVersionListItem } from "@workbench/workbench-contracts";
import { CheckIcon, GitCompareArrowsIcon, HistoryIcon, PinIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  artifactVersionNeedsBlobText,
  artifactVersionPinCompatibility,
  projectArtifactVersion,
  readArtifactVersionBlobText,
  type ArtifactVersionProjection,
} from "@/lib/workbench/artifact-versions/projection";
import {
  useWorkbenchArtifact,
  useWorkbenchArtifactVersion,
  useWorkbenchArtifactVersionContent,
  useInfiniteWorkbenchArtifactVersions,
} from "@/lib/workbench/features";
import { WorkbenchArtifactContent } from "./workbench-artifact-content";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import { WorkbenchArtifactVersionMerge } from "./workbench-artifact-version-merge";

type VersionView = "preview" | "compare";
type ProjectionState =
  | { status: "loading"; value: null; error: null }
  | { status: "error"; value: null; error: unknown }
  | { status: "ready"; value: ArtifactVersionProjection; error: null };

export function WorkbenchArtifactVersionDialog({
  canPin,
  onOpenChange,
  onPinVersion,
  open,
  reference,
}: {
  canPin: boolean;
  onOpenChange: (open: boolean) => void;
  onPinVersion: (
    artifactId: string,
    pinnedArtifactVersionId: string,
    targetArtifactVersionId: string,
  ) => Promise<unknown>;
  open: boolean;
  reference: WorkbenchArtifactReference | null;
}) {
  const projectId = reference?.projectId ?? "";
  const artifactId = reference?.artifactId ?? "";
  const pinnedVersionId = reference?.artifactVersionId ?? "";
  const [selectedVersionId, setSelectedVersionId] = useState(pinnedVersionId);
  const [view, setView] = useState<VersionView>("preview");
  const [pinning, setPinning] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const artifactQuery = useWorkbenchArtifact(projectId, artifactId);
  const versionsQuery = useInfiniteWorkbenchArtifactVersions(projectId, artifactId, { limit: 100 });
  const pinnedQuery = useWorkbenchArtifactVersion(
    projectId,
    artifactId,
    pinnedVersionId,
    open && Boolean(reference),
  );
  const selectedQuery = useWorkbenchArtifactVersion(
    projectId,
    artifactId,
    selectedVersionId,
    open && Boolean(reference && selectedVersionId),
  );
  const pinnedVersion = pinnedQuery.data?.value;
  const selectedVersion = selectedQuery.data?.value;
  const pinnedBlobQuery = useWorkbenchArtifactVersionContent(
    projectId,
    artifactId,
    pinnedVersionId,
    open && view === "compare" && artifactVersionNeedsBlobText(pinnedVersion),
  );
  const selectedBlobQuery = useWorkbenchArtifactVersionContent(
    projectId,
    artifactId,
    selectedVersionId,
    open && view === "compare" && artifactVersionNeedsBlobText(selectedVersion),
  );
  const pinnedProjection = useArtifactVersionProjection(
    pinnedVersion,
    pinnedBlobQuery.data,
    pinnedBlobQuery.error,
  );
  const selectedProjection = useArtifactVersionProjection(
    selectedVersion,
    selectedBlobQuery.data,
    selectedBlobQuery.error,
  );

  useEffect(() => {
    setSelectedVersionId(pinnedVersionId);
    setView("preview");
    setPinError(null);
  }, [artifactId, open, pinnedVersionId]);

  const versions = versionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const hasNextPage = versionsQuery.hasNextPage;
  const pinnedOutsideLoadedPage = pinnedVersion
    && hasNextPage
    && !versions.some((version) => version.artifactVersionId === pinnedVersionId)
      ? pinnedVersion
      : null;
  const visibleVersions: ArtifactVersionListItem[] = pinnedOutsideLoadedPage
    ? [pinnedOutsideLoadedPage, ...versions]
    : versions;
  const currentVersionId = artifactQuery.data?.value.currentVersion?.artifactVersionId ?? null;
  const selectedListItem = versions.find((version) => (
    version.artifactVersionId === selectedVersionId
  ));
  const selectedVersionNumber = selectedListItem?.version ?? selectedVersion?.version ?? null;
  const pinnedVersionNumber = versions.find((version) => (
    version.artifactVersionId === pinnedVersionId
  ))?.version ?? pinnedVersion?.version ?? null;
  const pinCompatibility = reference
    ? artifactVersionPinCompatibility(reference, selectedVersion)
    : { allowed: false, reason: "未选择产物" };
  const canSubmitPin = canPin
    && selectedVersionId !== pinnedVersionId
    && pinCompatibility.allowed
    && !pinning;

  const selectedReference = useMemo<WorkbenchArtifactReference | null>(() => (
    reference && selectedVersionId
      ? { ...reference, artifactVersionId: selectedVersionId }
      : null
  ), [reference, selectedVersionId]);

  const handlePin = async () => {
    if (!reference || !canSubmitPin) return;
    setPinning(true);
    setPinError(null);
    try {
      await onPinVersion(reference.artifactId, pinnedVersionId, selectedVersionId);
      toast.success(`画布已固定到 v${selectedVersionNumber ?? selectedVersionId}`);
      onOpenChange(false);
    } catch (error) {
      setPinError(errorMessage(error, "版本固定失败，请重试"));
    } finally {
      setPinning(false);
    }
  };

  return (
    <Dialog onOpenChange={(nextOpen) => !pinning && onOpenChange(nextOpen)} open={open}>
      <DialogContent
        className="grid h-[min(760px,calc(100vh-32px))] w-[min(1080px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-white/[0.10] bg-[#18191b]/98 p-0 text-[#f1f3f4]"
        data-artifact-version-dialog
      >
        <DialogHeader className="border-b border-white/[0.08] px-[22px] py-[18px] pr-[60px]">
          <div className="flex flex-wrap items-center justify-between gap-[12px]">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-[9px] text-[16px]">
                <HistoryIcon className="size-[17px] text-[#b8b0ff]" />
                版本记录
              </DialogTitle>
              <DialogDescription className="mt-[6px] text-[12px] text-[#9da2aa]">
                画布固定在 v{pinnedVersionNumber ?? "-"}。选择历史版本只会预览，固定操作才会更新 Board。
              </DialogDescription>
            </div>
            <div className="flex h-[32px] items-center rounded-[6px] border border-white/[0.08] bg-[#222326] p-[3px]">
              <VersionViewButton active={view === "preview"} onClick={() => setView("preview")}>预览</VersionViewButton>
              <VersionViewButton active={view === "compare"} onClick={() => setView("compare")}>比较</VersionViewButton>
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[238px_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[170px_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-auto border-r border-white/[0.08] bg-[#151618] p-[10px] max-md:border-b max-md:border-r-0" aria-label="产物版本列表">
            <VersionList
              currentVersionId={currentVersionId}
              error={versionsQuery.error}
              includesPinnedOutsidePage={Boolean(pinnedOutsideLoadedPage)}
              loadingMore={versionsQuery.isFetchingNextPage}
              loading={versionsQuery.isPending}
              hasNextPage={hasNextPage}
              onLoadMore={() => void versionsQuery.fetchNextPage()}
              onRetry={() => void versionsQuery.refetch()}
              onSelect={(versionId) => {
                setSelectedVersionId(versionId);
                setPinError(null);
              }}
              pinnedVersionId={pinnedVersionId}
              selectedVersionId={selectedVersionId}
              versions={visibleVersions}
            />
          </aside>

          <section className="relative min-h-0 overflow-hidden bg-[#111214]" aria-live="polite">
            {view === "preview" ? (
              <VersionPreview
                error={selectedQuery.error}
                loading={selectedQuery.isPending}
                reference={selectedReference}
                version={selectedVersion}
              />
            ) : selectedVersionId === pinnedVersionId ? (
              <VersionState icon={<GitCompareArrowsIcon className="size-[20px]" />}>
                请选择另一个版本进行比较
              </VersionState>
            ) : (
              <VersionComparison
                after={selectedProjection}
                afterLabel={`预览 v${selectedVersionNumber ?? "-"}`}
                before={pinnedProjection}
                beforeLabel={`画布固定 v${pinnedVersionNumber ?? "-"}`}
                detailsError={pinnedQuery.error ?? selectedQuery.error}
                detailsLoading={pinnedQuery.isPending || selectedQuery.isPending}
              />
            )}
          </section>
        </div>

        <DialogFooter className="min-h-[58px] items-center justify-between border-t border-white/[0.08] bg-[#18191b] px-[18px] py-[10px] max-sm:flex-col max-sm:items-stretch">
          <div className="min-w-0 text-[11px] leading-[16px] text-[#9da2aa]">
            {pinError ? <span className="text-[#f2a7a7]">{pinError}</span>
              : !canPin ? "当前角色只能预览版本"
                : selectedVersionId === pinnedVersionId ? "当前选择就是画布固定版本"
                  : pinCompatibility.reason ?? `正在预览 v${selectedVersionNumber ?? "-"}`}
          </div>
          <button
            className="flex h-[34px] shrink-0 items-center justify-center gap-[8px] rounded-[6px] bg-[#e8eaed] px-[15px] text-[12px] font-semibold text-[#202124] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!canSubmitPin}
            onClick={() => void handlePin()}
            type="button"
          >
            {pinning ? <span className="size-[13px] animate-spin rounded-full border-2 border-[#202124]/35 border-t-[#202124]" /> : <PinIcon className="size-[14px]" />}
            {pinning ? "正在固定..." : "固定到画布"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionViewButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "h-[24px] rounded-[4px] px-[12px] text-[11px] font-semibold transition-colors",
        active ? "bg-[#4b4d52] text-white" : "text-[#aeb3bb] hover:text-white",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function VersionList({
  currentVersionId,
  error,
  includesPinnedOutsidePage,
  loadingMore,
  loading,
  hasNextPage,
  onLoadMore,
  onRetry,
  onSelect,
  pinnedVersionId,
  selectedVersionId,
  versions,
}: {
  currentVersionId: string | null;
  error: unknown;
  includesPinnedOutsidePage: boolean;
  loadingMore: boolean;
  loading: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelect: (versionId: string) => void;
  pinnedVersionId: string;
  selectedVersionId: string;
  versions: ArtifactVersionListItem[];
}) {
  if (loading) return <VersionState>正在读取版本...</VersionState>;
  if (error) {
    return (
      <VersionState>
        <span>版本记录加载失败</span>
        <button className="text-[#b8b0ff] hover:text-white" onClick={onRetry} type="button">重试</button>
      </VersionState>
    );
  }
  if (versions.length === 0) return <VersionState>暂无版本记录</VersionState>;
  return (
    <div className="space-y-[4px]">
      {versions.map((version) => {
        const selected = version.artifactVersionId === selectedVersionId;
        return (
          <button
            aria-current={selected ? "true" : undefined}
            className={cn(
              "flex min-h-[50px] w-full items-center gap-[9px] rounded-[6px] px-[9px] py-[7px] text-left transition-colors",
              selected ? "bg-[#303136] text-white" : "text-[#c9cdd3] hover:bg-white/[0.05]",
            )}
            key={version.artifactVersionId}
            onClick={() => onSelect(version.artifactVersionId)}
            type="button"
          >
            <span className={cn(
              "grid size-[20px] shrink-0 place-items-center rounded-full border text-[10px]",
              selected ? "border-[#8f83ff] bg-[#7467f6]/20 text-[#ddd9ff]" : "border-white/[0.10] text-[#858b93]",
            )}>
              {selected ? <CheckIcon className="size-[11px]" /> : version.version}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-[5px] text-[12px] font-semibold">
                v{version.version}
                {version.artifactVersionId === pinnedVersionId && <VersionBadge>画布</VersionBadge>}
                {version.artifactVersionId === currentVersionId && <VersionBadge>当前</VersionBadge>}
              </span>
              <span className="mt-[2px] block truncate text-[10px] text-[#838991]">
                {version.createdAt.slice(0, 10)} · {version.status}
              </span>
            </span>
          </button>
        );
      })}
      {hasNextPage && (
        <button
          className="w-full px-[8px] py-[8px] text-center text-[10px] leading-[14px] text-[#9f98ff] transition-colors hover:text-white disabled:cursor-wait disabled:text-[#777d85]"
          disabled={loadingMore}
          onClick={onLoadMore}
          type="button"
        >
          {loadingMore
            ? "正在加载更早版本..."
            : includesPinnedOutsidePage
              ? "加载更早版本（另含画布固定版本）"
              : "加载更早版本"}
        </button>
      )}
    </div>
  );
}

function VersionBadge({ children }: { children: string }) {
  return <span className="rounded-[3px] bg-white/[0.08] px-[4px] py-[1px] text-[9px] text-[#b8bdc5]">{children}</span>;
}

function VersionPreview({
  error,
  loading,
  reference,
  version,
}: {
  error: unknown;
  loading: boolean;
  reference: WorkbenchArtifactReference | null;
  version: ArtifactVersionDetail | undefined;
}) {
  if (loading) return <VersionState>正在加载版本内容...</VersionState>;
  if (error || !version || !reference) return <VersionState>版本内容不可用</VersionState>;
  return (
    <div className="h-full min-h-0 overflow-hidden" data-artifact-version-preview>
      <WorkbenchArtifactContent reference={reference} />
    </div>
  );
}

function VersionComparison({
  after,
  afterLabel,
  before,
  beforeLabel,
  detailsError,
  detailsLoading,
}: {
  after: ProjectionState;
  afterLabel: string;
  before: ProjectionState;
  beforeLabel: string;
  detailsError: unknown;
  detailsLoading: boolean;
}) {
  if (detailsLoading || before.status === "loading" || after.status === "loading") {
    return <VersionState>正在生成确定性比较...</VersionState>;
  }
  if (detailsError || before.status === "error" || after.status === "error") {
    return <VersionState>版本比较内容不可用</VersionState>;
  }
  const note = before.value.note ?? after.value.note;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="border-b border-white/[0.08] bg-[#17181b] px-[12px] py-[8px]">
        <div className="grid grid-cols-2 gap-[12px] text-[10px] font-semibold text-[#aeb3bb]">
          <span>{beforeLabel}</span>
          <span>{afterLabel}</span>
        </div>
        {note && <p className="mt-[5px] text-[10px] leading-[14px] text-[#d1b680]">{note}</p>}
      </div>
      <WorkbenchArtifactVersionMerge after={after.value.text} before={before.value.text} />
    </div>
  );
}

function VersionState({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-[8px] px-[20px] text-center text-[12px] text-[#969ca4]">
      {icon}
      {children}
    </div>
  );
}

function useArtifactVersionProjection(
  version: ArtifactVersionDetail | undefined,
  blob: Blob | undefined,
  blobError: unknown,
): ProjectionState {
  const [state, setState] = useState<ProjectionState>({ status: "loading", value: null, error: null });
  useEffect(() => {
    let active = true;
    if (!version) {
      setState({ status: "loading", value: null, error: null });
      return () => { active = false; };
    }
    if (blobError) {
      setState({ status: "error", value: null, error: blobError });
      return () => { active = false; };
    }
    const needsBlob = artifactVersionNeedsBlobText(version);
    if (needsBlob && !blob) {
      setState({ status: "loading", value: null, error: null });
      return () => { active = false; };
    }
    setState({ status: "loading", value: null, error: null });
    void Promise.resolve(needsBlob ? readArtifactVersionBlobText(blob!) : undefined)
      .then((blobText) => projectArtifactVersion(version, blobText))
      .then((value) => {
        if (active) setState({ status: "ready", value, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: "error", value: null, error });
      });
    return () => { active = false; };
  }, [blob, blobError, version]);
  return state;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

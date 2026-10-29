"use client";

import type {
  ArtifactFinalization,
  ArtifactVersionDetail,
  ArtifactVersionListItem,
} from "@workbench/workbench-contracts";
import {
  CheckCircle2Icon,
  CheckIcon,
  DatabaseIcon,
  GitCompareArrowsIcon,
  HistoryIcon,
  PinIcon,
  RotateCcwIcon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  useUpdateWorkbenchArtifactFinalization,
  useWorkbenchArtifactVersion,
  useWorkbenchArtifactVersionContent,
  useWorkbenchArtifactFinalization,
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
  canFinalize,
  canPin,
  onOpenChange,
  onPinVersion,
  open,
  reference,
}: {
  canFinalize: boolean;
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
  const [finalizationAction, setFinalizationAction] = useState<"confirm" | "withdraw" | null>(null);
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
  const finalizationQuery = useWorkbenchArtifactFinalization(
    projectId,
    artifactId,
    selectedVersionId,
    canFinalize && open && selectedVersion?.status === "ready",
  );
  const finalizationMutation = useUpdateWorkbenchArtifactFinalization(
    projectId,
    artifactId,
    selectedVersionId,
  );
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
    setFinalizationAction(null);
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
  const finalization = finalizationQuery.data ?? null;
  const canConfirmFinalization = canFinalize
    && selectedVersion?.status === "ready"
    && !finalization
    && !finalizationMutation.isPending;
  const canRetryFinalization = canFinalize
    && finalization?.ingestionJob?.status === "failed"
    && !finalizationMutation.isPending;
  const canWithdrawFinalization = canFinalize
    && Boolean(finalization)
    && finalization?.status !== "withdrawn"
    && !finalizationMutation.isPending;

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

  const handleFinalizationAction = async () => {
    if (!finalizationAction || !selectedVersion || finalizationMutation.isPending) return;
    try {
      if (finalizationAction === "confirm") {
        await finalizationMutation.mutateAsync({
          kind: "confirm",
          checksum: selectedVersion.checksum,
        });
        toast.success(`已确认 v${selectedVersionNumber ?? selectedVersionId}，知识入库已排队`);
      } else {
        await finalizationMutation.mutateAsync({ kind: "withdraw" });
        toast.success("已撤回该版本的知识入库");
      }
      setFinalizationAction(null);
    } catch (error) {
      toast.error(errorMessage(
        error,
        finalizationAction === "confirm" ? "最终版确认失败，请重试" : "撤回失败，请重试",
      ));
    }
  };

  const handleRetryFinalization = async () => {
    if (!canRetryFinalization || finalizationMutation.isPending) return;
    try {
      await finalizationMutation.mutateAsync({ kind: "retry" });
      toast.success("知识入库已重新排队");
    } catch (error) {
      toast.error(errorMessage(error, "重试入库失败，请稍后再试"));
    }
  };

  return (
    <>
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
              <DialogDescription className="mt-[6px] text-[13px] text-[#9da2aa]">
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

        <DialogFooter className="min-h-[76px] items-center justify-between gap-[16px] border-t border-white/[0.08] bg-[#18191b] px-[18px] py-[10px] max-sm:flex-col max-sm:items-stretch">
          <div className="min-w-0 flex-1 space-y-[5px] text-[12px] leading-[16px] text-[#9da2aa]">
            <div>
              {pinError ? <span className="text-[#f2a7a7]">{pinError}</span>
                : !canPin ? "当前角色只能预览版本"
                  : selectedVersionId === pinnedVersionId ? "当前选择就是画布固定版本"
                    : pinCompatibility.reason ?? `正在预览 v${selectedVersionNumber ?? "-"}`}
            </div>
            {canFinalize && (
              <FinalizationStatus
                canConfirm={canConfirmFinalization}
                canRetry={canRetryFinalization}
                canWithdraw={canWithdrawFinalization}
                finalization={finalization}
                loading={finalizationQuery.isPending}
                onConfirm={() => setFinalizationAction("confirm")}
                onRetry={() => void handleRetryFinalization()}
                onWithdraw={() => setFinalizationAction("withdraw")}
                pending={finalizationMutation.isPending}
                versionReady={selectedVersion?.status === "ready"}
              />
            )}
          </div>
          <button
            className="flex h-[34px] shrink-0 items-center justify-center gap-[8px] rounded-[6px] bg-[#e8eaed] px-[15px] text-[13px] font-semibold text-[#202124] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
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
      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !finalizationMutation.isPending) setFinalizationAction(null);
        }}
        open={Boolean(finalizationAction)}
      >
        <AlertDialogContent className="border-white/[0.10] bg-[#1b1c1f] text-[#f1f3f4]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {finalizationAction === "confirm" ? "确认这个版本为最终版？" : "撤回这个版本的知识入库？"}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[#aeb3bb]">
              {finalizationAction === "confirm"
                ? `v${selectedVersionNumber ?? "-"} 将生成私有知识快照并追加到项目知识库。当前知识库不会被覆盖。`
                : "该版本及其派生知识版本会停止生效；历史内容会保留，之后可以重新确认其他版本。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={finalizationMutation.isPending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={finalizationMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                void handleFinalizationAction();
              }}
            >
              {finalizationMutation.isPending
                ? "处理中..."
                : finalizationAction === "confirm" ? "确认入库" : "确认撤回"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FinalizationStatus({
  canConfirm,
  canRetry,
  canWithdraw,
  finalization,
  loading,
  onConfirm,
  onRetry,
  onWithdraw,
  pending,
  versionReady,
}: {
  canConfirm: boolean;
  canRetry: boolean;
  canWithdraw: boolean;
  finalization: ArtifactFinalization | null;
  loading: boolean;
  onConfirm: () => void;
  onRetry: () => void;
  onWithdraw: () => void;
  pending: boolean;
  versionReady: boolean;
}) {
  const status = finalizationStatus(finalization, loading, versionReady);
  return (
    <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]" data-finalization-status>
      <span className="inline-flex items-center gap-[5px]">
        <DatabaseIcon className="size-[12px] text-[#aaa3ff]" />
        知识库：{status.label}
      </span>
      {canConfirm && (
        <button
          className="inline-flex items-center gap-[4px] text-[#c1bbff] transition-colors hover:text-white disabled:cursor-wait disabled:opacity-50"
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          <CheckCircle2Icon className="size-[12px]" />
          确认最终版
        </button>
      )}
      {canRetry && (
        <button
          className="inline-flex items-center gap-[4px] text-[#f1cb8a] transition-colors hover:text-white disabled:cursor-wait disabled:opacity-50"
          disabled={pending}
          onClick={onRetry}
          type="button"
        >
          <RotateCcwIcon className="size-[12px]" />
          重试入库
        </button>
      )}
      {canWithdraw && (
        <button
          className="inline-flex items-center gap-[4px] text-[#f2a7a7] transition-colors hover:text-white disabled:cursor-wait disabled:opacity-50"
          disabled={pending}
          onClick={onWithdraw}
          type="button"
        >
          <Undo2Icon className="size-[12px]" />
          撤回
        </button>
      )}
    </div>
  );
}

function finalizationStatus(
  finalization: ArtifactFinalization | null,
  loading: boolean,
  versionReady: boolean,
) {
  if (loading) return { label: "正在读取状态" };
  if (!versionReady) return { label: "仅 ready 版本可入库" };
  if (!finalization) return { label: "尚未确认" };
  if (finalization.status === "withdrawn") return { label: "已撤回" };
  if (finalization.ingestionJob?.status === "failed" || finalization.status === "rejected") {
    return { label: "入库失败" };
  }
  if (finalization.ingestionJob?.status === "published" || finalization.status === "ingested") {
    return { label: "已入库" };
  }
  if (finalization.ingestionJob?.status === "publishing") return { label: "正在发布" };
  if (finalization.ingestionJob?.status === "indexing") return { label: "正在索引" };
  if (finalization.ingestionJob?.status === "converting") return { label: "正在转换" };
  return { label: "等待入库" };
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
        "h-[24px] rounded-[4px] px-[12px] text-[12px] font-semibold transition-colors",
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
              "grid size-[20px] shrink-0 place-items-center rounded-full border text-[12px]",
              selected ? "border-[#8f83ff] bg-[#7467f6]/20 text-[#ddd9ff]" : "border-white/[0.10] text-[#858b93]",
            )}>
              {selected ? <CheckIcon className="size-[11px]" /> : version.version}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-[5px] text-[13px] font-semibold">
                v{version.version}
                {version.artifactVersionId === pinnedVersionId && <VersionBadge>画布</VersionBadge>}
                {version.artifactVersionId === currentVersionId && <VersionBadge>当前</VersionBadge>}
              </span>
              <span className="mt-[2px] block truncate text-[12px] text-[#838991]">
                {version.createdAt.slice(0, 10)} · {version.status}
              </span>
            </span>
          </button>
        );
      })}
      {hasNextPage && (
        <button
          className="w-full px-[8px] py-[8px] text-center text-[12px] leading-[14px] text-[#9f98ff] transition-colors hover:text-white disabled:cursor-wait disabled:text-[#777d85]"
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
  return <span className="rounded-[3px] bg-white/[0.08] px-[4px] py-[1px] text-[12px] text-[#b8bdc5]">{children}</span>;
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
        <div className="grid grid-cols-2 gap-[12px] text-[12px] font-semibold text-[#aeb3bb]">
          <span>{beforeLabel}</span>
          <span>{afterLabel}</span>
        </div>
        {note && <p className="mt-[5px] text-[12px] leading-[14px] text-[#d1b680]">{note}</p>}
      </div>
      <WorkbenchArtifactVersionMerge after={after.value.text} before={before.value.text} />
    </div>
  );
}

function VersionState({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] flex-col items-center justify-center gap-[8px] px-[20px] text-center text-[13px] text-[#969ca4]">
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

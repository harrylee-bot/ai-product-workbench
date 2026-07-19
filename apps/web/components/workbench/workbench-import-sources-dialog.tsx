"use client";

import type { ImportSource } from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FigmaIcon,
  GithubIcon,
  Globe2Icon,
  InfoIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  useCreateWorkbenchImportSource,
  useDeleteWorkbenchImportSource,
  useWorkbenchImportSource,
  useWorkbenchImportSources,
} from "@/lib/workbench/features/import-sources";
import {
  figmaVersionFromInput,
  type ImportSourceDraft,
  importSourceKindLabels,
  importSourceLabel,
  importSourceStatusLabels,
  isImportSourceUrlAllowed,
  isReadyImportSource,
  normalizeFigmaFileKey,
  normalizeGitHubRepository,
} from "@/lib/workbench/features/import-sources";

type ImportMode = "file" | "url_snapshot" | "github_snapshot" | "figma_snapshot";

export type WorkbenchImportSourcesDialogProps = {
  disabled?: boolean;
  onCreateExternalSource?: (
    request: ImportSourceDraft,
  ) => Promise<ImportSource | null>;
  onOpenChange: (open: boolean) => void;
  onSelectFiles: () => void;
  onSelectedSourceIdsChange: (sourceIds: string[]) => void;
  open: boolean;
  projectId?: string;
  selectedSourceIds: readonly string[];
};

export function WorkbenchImportSourcesDialog({
  disabled = false,
  onCreateExternalSource,
  onOpenChange,
  onSelectFiles,
  onSelectedSourceIdsChange,
  open,
  projectId = "",
  selectedSourceIds,
}: WorkbenchImportSourcesDialogProps) {
  const [mode, setMode] = useState<ImportMode>("file");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [repository, setRepository] = useState("");
  const [ref, setRef] = useState("main");
  const [figmaKey, setFigmaKey] = useState("");
  const [figmaVersion, setFigmaVersion] = useState("");
  const [detailSourceId, setDetailSourceId] = useState("");
  const [deletedSources, setDeletedSources] = useState<ImportSource[]>([]);
  const [externalCreatePending, setExternalCreatePending] = useState(false);
  const deletedSourceTimersRef = useRef(new Map<string, number>());
  const sourcesQuery = useWorkbenchImportSources(projectId);
  const createMutation = useCreateWorkbenchImportSource(projectId);
  const deleteMutation = useDeleteWorkbenchImportSource(projectId);
  const detailQuery = useWorkbenchImportSource(projectId, detailSourceId);
  const sources = sourcesQuery.data?.items ?? [];
  const readySourceIds = useMemo(
    () => new Set(sources.filter(isReadyImportSource).map((source) => source.id)),
    [sources],
  );

  useEffect(() => {
    if (!open) return;
    setMode("file");
    setLabel("");
    setUrl("");
    setRepository("");
    setRef("main");
    setFigmaKey("");
    setFigmaVersion("");
    setDetailSourceId("");
  }, [open]);

  useEffect(() => {
    setDeletedSources([]);
    setDetailSourceId("");
    return () => {
      for (const timer of deletedSourceTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      deletedSourceTimersRef.current.clear();
    };
  }, [projectId]);

  useEffect(() => {
    if (!sourcesQuery.isSuccess) return;
    const next = selectedSourceIds.filter((sourceId) => readySourceIds.has(sourceId));
    if (next.length !== selectedSourceIds.length) onSelectedSourceIdsChange(next);
  }, [onSelectedSourceIdsChange, readySourceIds, selectedSourceIds, sourcesQuery.isSuccess]);

  const setSelected = (source: ImportSource) => {
    if (!isReadyImportSource(source)) return;
    const next = selectedSourceIds.includes(source.id)
      ? selectedSourceIds.filter((sourceId) => sourceId !== source.id)
      : [...selectedSourceIds, source.id];
    onSelectedSourceIdsChange(next);
  };

  const createSource = async () => {
    const request = buildRequest({
      figmaKey,
      figmaVersion,
      label,
      mode,
      ref,
      repository,
      url,
    });
    if (!request) return;
    if (!projectId && !onCreateExternalSource) {
      toast.error("当前无法创建来源项目，请重试");
      return;
    }
    if (!projectId) setExternalCreatePending(true);
    try {
      const result = projectId
        ? (await createMutation.mutateAsync({ request })).value
        : await onCreateExternalSource?.(request);
      if (!result) return;
      toast.success(
        result.status === "pending"
          ? "来源已加入队列，完成后可选择"
          : "来源已加入项目",
      );
      setLabel("");
      setUrl("");
      setRepository("");
      setRef("main");
      setFigmaKey("");
      setFigmaVersion("");
      if (projectId) setMode("file");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加来源失败，请重试");
    } finally {
      if (!projectId) setExternalCreatePending(false);
    }
  };

  const deleteSource = async (source: ImportSource) => {
    if (!projectId || deleteMutation.isPending) return;
    try {
      await deleteMutation.mutateAsync({
        sourceId: source.id,
        ifMatch: `"${source.revision}"`,
      });
      onSelectedSourceIdsChange(selectedSourceIds.filter((sourceId) => sourceId !== source.id));
      setDetailSourceId((current) => current === source.id ? "" : current);
      setDeletedSources((current) => [
        ...current.filter((item) => item.id !== source.id),
        { ...source, status: "deleted", deletedAt: new Date().toISOString() },
      ]);
      const timer = window.setTimeout(() => {
        setDeletedSources((current) => current.filter((item) => item.id !== source.id));
        deletedSourceTimersRef.current.delete(source.id);
      }, 1_600);
      deletedSourceTimersRef.current.set(source.id, timer);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除来源失败，请重试");
    }
  };

  const busy = disabled
    || externalCreatePending
    || createMutation.isPending
    || deleteMutation.isPending;
  const detailSource = detailQuery.data?.value
    ?? sources.find((source) => source.id === detailSourceId)
    ?? null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="w-[min(760px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden border-white/[0.12] bg-[#17181b]/96 p-0 text-[#e7e9ed] shadow-[0_28px_110px_-42px_rgba(0,0,0,0.98)]"
        data-import-sources-dialog
      >
        <DialogHeader className="border-b border-white/[0.08] px-[24px] pb-[18px] pt-[22px]">
          <DialogTitle className="text-[18px] font-semibold text-[#f1f3f4]">添加来源</DialogTitle>
          <DialogDescription className="max-w-[620px] text-[12px] leading-[18px] text-[#aeb3bb]">
            {projectId
              ? "来源会固定为本项目的一次输入快照，只有状态为“可用”的来源才能参与生成。"
              : "确认外部来源后会创建一个真实项目，来源完成后可继续生成。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-[430px] grid-cols-1 md:grid-cols-[220px_1fr]">
          <div className="border-b border-white/[0.08] bg-[#141518]/72 p-[14px] md:border-b-0 md:border-r">
            <div className="mb-[12px] text-[11px] font-semibold uppercase tracking-[0.08em] text-[#858b94]">
              新来源
            </div>
            <div className="grid grid-cols-2 gap-[6px] md:grid-cols-1">
              <ModeButton active={mode === "file"} icon={UploadIcon} label="文件" onClick={() => setMode("file")} />
              <ModeButton active={mode === "url_snapshot"} icon={Globe2Icon} label="网站网址" onClick={() => setMode("url_snapshot")} />
              <ModeButton active={mode === "github_snapshot"} icon={GithubIcon} label="GitHub 仓库" onClick={() => setMode("github_snapshot")} />
              <ModeButton active={mode === "figma_snapshot"} icon={FigmaIcon} label="Figma 文件" onClick={() => setMode("figma_snapshot")} />
            </div>
            {projectId && (
              <div className="mt-[22px] border-t border-white/[0.08] pt-[18px]">
                <div className="mb-[10px] flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.08em] text-[#858b94]">
                  <span>项目来源</span>
                  <span className="tabular-nums text-[#6f747c]">{sources.length}</span>
                </div>
                <p className="text-[12px] leading-[18px] text-[#9ca1aa]">
                  选择可用来源后，它会作为下一次生成的固定输入。
                </p>
              </div>
            )}
          </div>

          <div className="min-w-0 p-[20px]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                initial={{ opacity: 0, y: 4 }}
                transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
              >
                {mode === "file" ? (
                  <FileSourceForm busy={busy} onSelectFiles={onSelectFiles} />
                ) : (
                  <ExternalSourceForm
                    busy={busy}
                    figmaKey={figmaKey}
                    figmaVersion={figmaVersion}
                    label={label}
                    mode={mode}
                    onFigmaKeyChange={(value) => {
                      setFigmaKey(value);
                      if (!figmaVersion) setFigmaVersion(figmaVersionFromInput(value) ?? "");
                    }}
                    onFigmaVersionChange={setFigmaVersion}
                    onLabelChange={setLabel}
                    onRefChange={setRef}
                    onRepositoryChange={setRepository}
                    onUrlChange={setUrl}
                    refValue={ref}
                    repository={repository}
                    url={url}
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {mode !== "file" && (
              <button
                className="mt-[16px] inline-flex h-[36px] items-center gap-[8px] rounded-full bg-[#f1f3f4] px-[15px] text-[13px] font-semibold text-[#202124] transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
                disabled={busy}
                onClick={() => void createSource()}
                type="button"
              >
                {createMutation.isPending || externalCreatePending ? <LoaderCircleIcon className="size-[15px] animate-spin" /> : <PlusIcon className="size-[15px]" />}
                添加来源
              </button>
            )}

            {projectId && (
              <div className="mt-[25px] border-t border-white/[0.08] pt-[17px]">
                <div className="mb-[10px] flex items-center justify-between">
                  <div className="flex items-center gap-[7px] text-[12px] font-semibold text-[#d7d9de]">
                    <CircleDashedIcon className="size-[14px] text-[#9ca1aa]" />
                    已添加来源
                  </div>
                  {sourcesQuery.isFetching && <LoaderCircleIcon className="size-[14px] animate-spin text-[#858b94]" />}
                </div>
                <SourceList
                  deletePending={deleteMutation.isPending}
                  deletedSources={deletedSources}
                  detailSourceId={detailSourceId}
                  error={sourcesQuery.error}
                  isLoading={sourcesQuery.isPending}
                  onDelete={deleteSource}
                  onDetail={setDetailSourceId}
                  onRetry={() => void sourcesQuery.refetch()}
                  onSelect={setSelected}
                  selectedSourceIds={selectedSourceIds}
                  sources={sources}
                />
              </div>
            )}

            <AnimatePresence>
              {detailSource && (
                <SourceDetail
                  onClose={() => setDetailSourceId("")}
                  source={detailSource}
                />
              )}
            </AnimatePresence>
          </div>
        </div>

        <DialogFooter className="border-t border-white/[0.08] px-[24px] py-[14px]">
          <div className="mr-auto flex items-center gap-[7px] text-[11px] text-[#858b94]">
            <InfoIcon className="size-[13px]" />
            {projectId ? `${selectedSourceIds.length} 个来源将用于下一次生成` : "文件会随当前提示一起上传"}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof UploadIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex h-[38px] items-center gap-[9px] rounded-[9px] px-[10px] text-left text-[12px] font-semibold transition-colors duration-150",
        active ? "bg-white/[0.11] text-[#f1f3f4]" : "text-[#b5bac2] hover:bg-white/[0.06] hover:text-[#e8eaed]",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-[15px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function FileSourceForm({
  busy,
  onSelectFiles,
}: {
  busy: boolean;
  onSelectFiles: () => void;
}) {
  return (
    <div className="rounded-[12px] border border-dashed border-white/[0.18] bg-white/[0.025] px-[20px] py-[26px] text-center">
      <div className="mx-auto grid size-[38px] place-items-center rounded-full bg-white/[0.08] text-[#d7d9de]">
        <UploadIcon className="size-[18px]" />
      </div>
      <h3 className="mt-[13px] text-[15px] font-semibold text-[#f1f3f4]">上传文件</h3>
      <p className="mx-auto mt-[6px] max-w-[390px] text-[12px] leading-[18px] text-[#9ca1aa]">
        支持图片、文档、代码和 DESIGN.md，文件会在提交时校验并固定为来源。
      </p>
      <button
        className="mt-[18px] inline-flex h-[36px] items-center gap-[8px] rounded-full border border-white/[0.15] bg-white/[0.08] px-[15px] text-[13px] font-semibold text-[#f1f3f4] transition-colors hover:bg-white/[0.13] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={busy}
        onClick={onSelectFiles}
        type="button"
      >
        <UploadIcon className="size-[15px]" />
        选择文件
      </button>
    </div>
  );
}

function ExternalSourceForm({
  busy,
  figmaKey,
  figmaVersion,
  label,
  mode,
  onFigmaKeyChange,
  onFigmaVersionChange,
  onLabelChange,
  onRefChange,
  onRepositoryChange,
  onUrlChange,
  refValue,
  repository,
  url,
}: {
  busy: boolean;
  figmaKey: string;
  figmaVersion: string;
  label: string;
  mode: Exclude<ImportMode, "file">;
  onFigmaKeyChange: (value: string) => void;
  onFigmaVersionChange: (value: string) => void;
  onLabelChange: (value: string) => void;
  onRefChange: (value: string) => void;
  onRepositoryChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  refValue: string;
  repository: string;
  url: string;
}) {
  const heading = mode === "url_snapshot"
    ? "导入网站"
    : mode === "github_snapshot"
      ? "导入 GitHub 仓库"
      : "导入 Figma 文件";
  return (
    <div>
      <div className="mb-[16px] flex items-center gap-[10px]">
        {mode === "url_snapshot" ? <Globe2Icon className="size-[18px] text-[#cfcaff]" /> : mode === "github_snapshot" ? <GithubIcon className="size-[18px] text-[#cfcaff]" /> : <FigmaIcon className="size-[18px] text-[#cfcaff]" />}
        <h3 className="text-[15px] font-semibold text-[#f1f3f4]">{heading}</h3>
      </div>
      {mode === "url_snapshot" && (
        <Field label="网站网址" hint="仅支持 HTTP(S)">
          <input
            autoFocus
            className={inputClass}
            disabled={busy}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="https://example.com"
            value={url}
          />
        </Field>
      )}
      {mode === "github_snapshot" && (
        <div className="grid gap-[12px] sm:grid-cols-[1.4fr_1fr]">
          <Field label="仓库" hint="owner/repository 或 GitHub URL">
            <input
              autoFocus
              className={inputClass}
              disabled={busy}
              onChange={(event) => onRepositoryChange(event.target.value)}
              placeholder="vercel/next.js"
              value={repository}
            />
          </Field>
          <Field label="分支或标签">
            <input
              className={inputClass}
              disabled={busy}
              onChange={(event) => onRefChange(event.target.value)}
              placeholder="main"
              value={refValue}
            />
          </Field>
        </div>
      )}
      {mode === "figma_snapshot" && (
        <div className="grid gap-[12px] sm:grid-cols-[1.25fr_1fr]">
          <Field label="文件链接或 Key" hint="支持 Figma 文件链接">
            <input
              autoFocus
              className={inputClass}
              disabled={busy}
              onChange={(event) => onFigmaKeyChange(event.target.value)}
              placeholder="https://www.figma.com/design/..."
              value={figmaKey}
            />
          </Field>
          <Field label="版本 ID（可选）">
            <input
              className={inputClass}
              disabled={busy}
              onChange={(event) => onFigmaVersionChange(event.target.value)}
              placeholder="留空使用最新版本"
              value={figmaVersion}
            />
          </Field>
        </div>
      )}
      <Field label="显示名称（可选）" className="mt-[14px]">
        <input
          className={inputClass}
          disabled={busy}
          maxLength={240}
          onChange={(event) => onLabelChange(event.target.value)}
          placeholder="例如：品牌官网参考"
          value={label}
        />
      </Field>
      <p className="mt-[16px] flex items-start gap-[7px] text-[11px] leading-[17px] text-[#858b94]">
        <InfoIcon className="mt-px size-[13px] shrink-0" />
        添加后会先显示“处理中”。外部内容只有在后台完成安全校验和快照固定后才会变为“可用”。
      </p>
    </div>
  );
}

function Field({
  children,
  className,
  hint,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  hint?: string;
  label: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-[7px] flex items-center gap-[7px] text-[11px] font-semibold text-[#c4c7ce]">
        {label}
        {hint && <span className="font-normal text-[#777d86]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass = "h-[40px] w-full rounded-[9px] border border-white/[0.12] bg-[#101114]/80 px-[12px] text-[13px] text-[#f1f3f4] outline-none transition-[border-color,background-color] duration-150 placeholder:text-[#6f747c] focus:border-white/[0.32] focus:bg-[#131519] disabled:cursor-not-allowed disabled:opacity-45";

function SourceList({
  deletePending,
  deletedSources,
  detailSourceId,
  error,
  isLoading,
  onDelete,
  onDetail,
  onRetry,
  onSelect,
  selectedSourceIds,
  sources,
}: {
  deletePending: boolean;
  deletedSources: readonly ImportSource[];
  detailSourceId: string;
  error: unknown;
  isLoading: boolean;
  onDelete: (source: ImportSource) => void;
  onDetail: (sourceId: string) => void;
  onRetry: () => void;
  onSelect: (source: ImportSource) => void;
  selectedSourceIds: readonly string[];
  sources: readonly ImportSource[];
}) {
  if (isLoading) {
    return <div className="flex h-[68px] items-center justify-center text-[12px] text-[#858b94]"><LoaderCircleIcon className="mr-[7px] size-[15px] animate-spin" />正在读取来源</div>;
  }
  if (error) {
    return (
      <div className="flex items-center justify-between rounded-[9px] border border-[#e27676]/25 bg-[#4a2226]/25 px-[12px] py-[10px] text-[12px] text-[#f1b3b3]">
        <span>来源列表读取失败</span>
        <button className="rounded-full px-[9px] py-[4px] text-[#f6d2d2] hover:bg-white/[0.08]" onClick={onRetry} type="button">重试</button>
      </div>
    );
  }
  if (sources.length === 0 && deletedSources.length === 0) {
    return <div className="rounded-[9px] border border-white/[0.08] bg-white/[0.02] px-[12px] py-[13px] text-[12px] text-[#858b94]">还没有项目来源</div>;
  }
  const deletedSourceIds = new Set(deletedSources.map((source) => source.id));
  const visibleSources = [
    ...sources.filter((source) => !deletedSourceIds.has(source.id)),
    ...deletedSources,
  ];
  return (
    <div className="overflow-hidden rounded-[10px] border border-white/[0.08]">
      <AnimatePresence initial={false}>
        {visibleSources.map((source) => (
          <SourceRow
            deletePending={deletePending}
            detailOpen={detailSourceId === source.id}
            key={source.id}
            onDelete={onDelete}
            onDetail={onDetail}
            onSelect={onSelect}
            selected={selectedSourceIds.includes(source.id)}
            source={source}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function SourceRow({
  deletePending,
  detailOpen,
  onDelete,
  onDetail,
  onSelect,
  selected,
  source,
}: {
  deletePending: boolean;
  detailOpen: boolean;
  onDelete: (source: ImportSource) => void;
  onDetail: (sourceId: string) => void;
  onSelect: (source: ImportSource) => void;
  selected: boolean;
  source: ImportSource;
}) {
  const Icon = source.kind === "url_snapshot"
    ? Globe2Icon
    : source.kind === "github_snapshot"
      ? GithubIcon
      : source.kind === "figma_snapshot"
        ? FigmaIcon
        : FileTextIcon;
  const ready = isReadyImportSource(source);
  return (
    <motion.div
      animate={{ opacity: 1, height: "auto" }}
      className={cn(
        "group border-b border-white/[0.07] bg-[#1b1c20]/64 px-[10px] py-[9px] last:border-b-0",
        selected && "bg-white/[0.08]",
      )}
      exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }}
      initial={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex min-w-0 items-center gap-[9px]">
        <button
          aria-label={ready ? `${selected ? "取消选择" : "选择"}${importSourceLabel(source)}` : `${importSourceLabel(source)}暂不可用`}
          className={cn(
            "grid size-[24px] shrink-0 place-items-center rounded-[6px] border transition-colors duration-150",
            ready
              ? selected
                ? "border-[#d9d5ff] bg-[#d9d5ff] text-[#27233f]"
                : "border-white/[0.18] bg-transparent text-transparent hover:border-white/[0.36]"
              : "cursor-not-allowed border-white/[0.08] bg-white/[0.03] text-transparent",
          )}
          disabled={!ready}
          onClick={() => onSelect(source)}
          type="button"
        >
          {selected && <CheckIcon className="size-[14px]" />}
        </button>
        <div className="grid size-[27px] shrink-0 place-items-center rounded-[7px] bg-white/[0.07] text-[#cfcaff]"><Icon className="size-[14px]" /></div>
        <button className="min-w-0 flex-1 text-left" onClick={() => onDetail(source.id)} type="button">
          <span className="block truncate text-[12px] font-semibold text-[#e8eaed]">{importSourceLabel(source)}</span>
          <span className="mt-[2px] block truncate text-[10px] text-[#858b94]">{importSourceKindLabels[source.kind]}</span>
        </button>
        <StatusPill status={source.status} />
        <button
          aria-label={`查看来源详情 ${importSourceLabel(source)}`}
          className={cn("grid size-[26px] shrink-0 place-items-center rounded-full text-[#858b94] hover:bg-white/[0.08] hover:text-[#e8eaed]", detailOpen && "bg-white/[0.09] text-[#f1f3f4]")}
          onClick={() => onDetail(detailOpen ? "" : source.id)}
          title="查看来源详情"
          type="button"
        >
          <ChevronRightIcon className={cn("size-[14px] transition-transform duration-150", detailOpen && "rotate-90")} />
        </button>
        {source.status !== "deleted" && (
          <button
            aria-label={`删除来源 ${importSourceLabel(source)}`}
            className="grid size-[26px] shrink-0 place-items-center rounded-full text-[#777d86] opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-[#4a2226]/50 hover:text-[#f1b3b3] group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={deletePending}
            onClick={() => onDelete(source)}
            title="删除来源"
            type="button"
          >
            <Trash2Icon className="size-[14px]" />
          </button>
        )}
      </div>
      {source.failure && (
        <div className="mt-[7px] flex items-start gap-[6px] pl-[33px] text-[10px] leading-[15px] text-[#f1b3b3]"><AlertCircleIcon className="mt-px size-[12px] shrink-0" />{source.failure.message}</div>
      )}
    </motion.div>
  );
}

function StatusPill({ status }: { status: ImportSource["status"] }) {
  const pending = status === "pending";
  const ready = status === "ready";
  return (
    <span className={cn(
      "inline-flex h-[22px] shrink-0 items-center gap-[5px] rounded-full border px-[7px] text-[10px] font-semibold",
      ready ? "border-[#9bc9a8]/25 bg-[#284130]/50 text-[#b6e2bf]" : status === "failed" ? "border-[#e27676]/25 bg-[#4a2226]/35 text-[#f1b3b3]" : status === "deleted" ? "border-white/[0.10] bg-white/[0.04] text-[#858b94]" : "border-[#d4bf7c]/25 bg-[#5c4d23]/30 text-[#e8d89c]",
    )}>
      {pending && <LoaderCircleIcon className="size-[11px] animate-spin" />}
      {ready && <CheckIcon className="size-[11px]" />}
      {status === "failed" && <AlertCircleIcon className="size-[11px]" />}
      {status === "deleted" && <Trash2Icon className="size-[11px]" />}
      {importSourceStatusLabels[status]}
    </span>
  );
}

function SourceDetail({
  onClose,
  source,
}: {
  onClose: () => void;
  source: ImportSource;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="mt-[10px] rounded-[10px] border border-white/[0.10] bg-[#111216]/88 px-[12px] py-[11px] text-[11px] text-[#aeb3bb]"
      exit={{ opacity: 0, y: -4 }}
      initial={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex items-center justify-between gap-[8px]">
        <span className="font-semibold text-[#d7d9de]">来源详情</span>
        <button aria-label="关闭来源详情" className="grid size-[22px] place-items-center rounded-full hover:bg-white/[0.08]" onClick={onClose} type="button"><XIcon className="size-[13px]" /></button>
      </div>
      <dl className="mt-[9px] grid gap-[6px] sm:grid-cols-[92px_1fr]">
        <dt className="text-[#777d86]">类型</dt><dd className="truncate text-[#c4c7ce]">{importSourceKindLabels[source.kind]}</dd>
        <dt className="text-[#777d86]">状态</dt><dd className="text-[#c4c7ce]">{importSourceStatusLabels[source.status]}</dd>
        <dt className="text-[#777d86]">版本</dt><dd className="text-[#c4c7ce]">{source.revision}</dd>
        <dt className="text-[#777d86]">更新时间</dt><dd className="text-[#c4c7ce]">{new Date(source.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd>
        <dt className="text-[#777d86]">定位</dt><dd className="min-w-0 truncate text-[#c4c7ce]">{source.descriptor ? descriptorText(source.descriptor) : "等待后台固定快照"}</dd>
      </dl>
      {source.descriptor?.kind === "url_snapshot" && (
        <a className="mt-[9px] inline-flex items-center gap-[5px] text-[#cfcaff] hover:underline" href={source.descriptor.sourceUrl} rel="noreferrer" target="_blank">
          打开来源 <ExternalLinkIcon className="size-[12px]" />
        </a>
      )}
    </motion.div>
  );
}

function descriptorText(source: NonNullable<ImportSource["descriptor"]>): string {
  if (source.kind === "url_snapshot") return source.resolvedUrl ?? source.sourceUrl;
  if (source.kind === "github_snapshot") return `${source.repository}@${source.commitSha.slice(0, 8)}`;
  if (source.kind === "figma_snapshot") return `${source.fileKey}@${source.versionId}`;
  return source.originalName;
}

function buildRequest({
  figmaKey,
  figmaVersion,
  label,
  mode,
  ref,
  repository,
  url,
}: {
  figmaKey: string;
  figmaVersion: string;
  label: string;
  mode: ImportMode;
  ref: string;
  repository: string;
  url: string;
}): ImportSourceDraft | null {
  if (mode === "url_snapshot") {
    if (!isImportSourceUrlAllowed(url)) {
      toast.error("请输入公开的 HTTP(S) 网站地址");
      return null;
    }
    return { kind: "url_snapshot", sourceUrl: url.trim(), ...(label.trim() ? { label: label.trim() } : {}) };
  }
  if (mode === "github_snapshot") {
    const normalized = normalizeGitHubRepository(repository);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(normalized)) {
      toast.error("请输入 owner/repository 格式的 GitHub 仓库");
      return null;
    }
    if (!ref.trim() || !/^[A-Za-z0-9._/-]+$/u.test(ref.trim())) {
      toast.error("请输入有效的分支或标签");
      return null;
    }
    return { kind: "github_snapshot", repository: normalized, ref: ref.trim(), ...(label.trim() ? { label: label.trim() } : {}) };
  }
  const normalizedKey = normalizeFigmaFileKey(figmaKey);
  if (!normalizedKey || !/^[A-Za-z0-9_-]+$/u.test(normalizedKey)) {
    toast.error("请输入有效的 Figma 文件 Key 或链接");
    return null;
  }
  const version = figmaVersion.trim() || figmaVersionFromInput(figmaKey);
  return {
    kind: "figma_snapshot",
    fileKey: normalizedKey,
    ...(version ? { versionId: version } : {}),
    ...(label.trim() ? { label: label.trim() } : {}),
  };
}

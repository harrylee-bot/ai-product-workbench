"use client";
import { useEffect, useRef, useState } from "react";
import { replaceEqualDeep, useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type {
  CreateExportJobRequest,
  ProjectBootstrap,
  ProjectRelease,
  ExportJob,
  ExportJobList,
} from "@workbench/workbench-contracts";
import {
  useWorkbenchExportsApi,
  useWorkbenchReleasesApi,
  useWorkbenchSharesApi,
} from "@/lib/studio/api";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { useStudioAction, saveBlob, verifyDownload } from "./actions";
import { CopyableLink } from "./project-members";
import { documentUrl } from "./relations";

const exportStatus = {
  queued: "排队中",
  running: "生成中",
  cancelling: "正在取消",
  succeeded: "可下载",
  failed: "失败",
  cancelled: "已取消",
};
const shareStatus = { active: "有效", revoked: "已撤销", expired: "已过期" };

// Both the cancel receipt and list refresh write this same project-scoped cache.
function mergeExportPages(previous: unknown, incoming: unknown) {
  const current = previous as InfiniteData<ExportJobList> | undefined;
  const next = incoming as InfiniteData<ExportJobList>;
  if (!current) return next;
  const known = new Map(current.pages.flatMap(page => page.items.map(job => [job.id, job] as const)));
  const pages = next.pages.map(page => ({
    ...page,
    items: page.items.map(job => {
      const seen = known.get(job.id);
      if (!seen) return job;
      if (seen.revision > job.revision) return seen;
      if (seen.finishedAt && !job.finishedAt) return seen;
      if (seen.status === "cancelling" && (job.status === "queued" || job.status === "running")) return seen;
      return job;
    }),
  }));
  return replaceEqualDeep(current, { ...next, pages });
}

export function ProjectPublishing({
  bootstrap,
  canEdit,
}: {
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
}) {
  const api = useWorkbenchReleasesApi(),
    exports = useWorkbenchExportsApi(),
    action = useStudioAction(),
    queryClient = useQueryClient();
  const projectId = bootstrap.project.id;
  const intents = useRef(new Map<string, { signature: string; key: string }>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const keyFor = (operation: string, request: unknown) => {
    const signature = JSON.stringify({ projectId, request }),
      previous = intents.current.get(operation);
    if (previous?.signature === signature) return previous.key;
    const key = createIdempotencyKey("studio-publish");
    intents.current.set(operation, { signature, key });
    return key;
  };
  const releases = useInfiniteQuery({
    queryKey: ["studio", "releases", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listProjectReleases(projectId, { cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  const jobs = useInfiniteQuery({
    queryKey: ["studio", "export-jobs", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      exports.listExportJobs(projectId, { cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 3000,
    structuralSharing: mergeExportPages,
  });
  const jobItems = jobs.data?.pages.flatMap((page) => page.items) ?? [];
  const createExport = async (
    request: CreateExportJobRequest,
    operation = "export",
  ) => {
    await exports.createExportJob(
      projectId,
      request,
      keyFor(operation, request),
    );
    intents.current.delete(operation);
    await jobs.refetch();
  };
  const releaseItems = releases.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <h1>项目发布与交付</h1>
      <p>
        发布记录固定当时的产物版本。后续编辑不会改写已有发布、分享或下载文件。
      </p>
      <button
        disabled={!canEdit || action.busy}
        onClick={() =>
          void action.run(async () => {
            const request = {
              boardId: bootstrap.board.id,
              boardRevision: bootstrap.board.revision,
            };
            await api.createProjectRelease(
              projectId,
              request,
              `"${bootstrap.board.revision}"`,
              keyFor("release", request),
            );
            intents.current.delete("release");
            await releases.refetch();
          }, "发布记录已创建")
        }
      >
        创建项目发布
      </button>
      {action.notice}
      {releases.isPending && <p role="status">正在读取发布记录…</p>}
      {releases.error && (
        <p role="alert">
          发布记录读取失败。
          <button onClick={() => void releases.refetch()}>重试发布记录</button>
        </p>
      )}
      {releaseItems.map((release) => (
        <article
          className="studio-card"
          key={release.id}
          aria-label={`发布 ${release.version}`}
        >
          <h2>发布 {release.version}</h2>
          <p>
            {release.status === "ready"
              ? "已就绪"
              : release.status === "building"
                ? "生成中"
                : "失败"}{" "}
            · {new Date(release.createdAt).toLocaleString()}
          </p>
          {release.artifactPins.map((artifact) => (
            <p key={artifact.artifactVersionId}>
              <a
                href={documentUrl(
                  projectId,
                  artifact.artifactId,
                  artifact.artifactVersionId,
                )}
              >
                {artifact.title} · 版本 {artifact.version}
              </a>
              {release.status === "ready" &&
                artifact.kind === "prd" &&
                (["docx", "pdf"] as const).map((format) => (
                  <button
                    key={format}
                    disabled={!canEdit || action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          createExport({
                            releaseId: release.id,
                            format,
                            packaging: "single_file",
                            selection: {
                              kind: "artifact",
                              artifactId: artifact.artifactId,
                              artifactVersionId: artifact.artifactVersionId,
                            },
                            options: {},
                          }),
                        "导出已排队",
                      )
                    }
                  >
                    导出 {format.toUpperCase()}
                  </button>
                ))}
            </p>
          ))}
        </article>
      ))}
      {releases.hasNextPage && (
        <button
          disabled={releases.isFetchingNextPage}
          onClick={() => void releases.fetchNextPage()}
        >
          加载更多发布
        </button>
      )}
      {!releases.isPending && !releases.error && releaseItems.length === 0 && (
        <p>尚无发布记录。</p>
      )}
      <ProjectShares
        key={projectId}
        projectId={projectId}
        owner={bootstrap.access.role === "owner"}
        releases={releaseItems}
      />
      <section aria-label="文档导出任务">
        <h2>文档导出任务</h2>
        {jobs.isPending && <p role="status">正在读取导出任务…</p>}
        {jobs.error && (
          <p role="alert">
            导出任务读取失败。
            <button onClick={() => void jobs.refetch()}>重试导出列表</button>
          </p>
        )}
        {jobItems.map((job) => (
            <article
              className="studio-card"
              key={job.id}
              aria-label={`导出 ${job.id}`}
            >
              <h3>
                {job.format.toUpperCase()} · {exportStatus[job.status]}
              </h3>
              <p>
                发布{" "}
                {releaseItems.find((release) => release.id === job.releaseId)
                  ?.version ?? job.releaseId}{" "}
                · {new Date(job.createdAt).toLocaleString()}
              </p>
              {job.selection.kind === "artifact" && (
                <a
                  href={documentUrl(
                    projectId,
                    job.selection.artifactId,
                    job.selection.artifactVersionId,
                  )}
                >
                  查看导出的固定版本
                </a>
              )}
              {job.status === "succeeded" && job.output && (
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const result = await exports.getExportContent(job.id);
                      await verifyDownload(result.value, {
                        sha256: job.output!.sha256,
                        size: job.output!.byteSize,
                      });
                      if (alive.current)
                        saveBlob(
                          result.value,
                          `workbench-${job.id}.${job.packaging === "zip" ? "zip" : job.format}`,
                        );
                    }, "文件校验通过，已向浏览器发起下载")
                  }
                >
                  下载并校验
                </button>
              )}
              {canEdit && ["queued", "running"].includes(job.status) && (
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      const result = await exports.cancelExportJob(
                        job.id,
                        `"${job.revision}"`,
                      );
                      queryClient.setQueryData(
                        ["studio", "export-jobs", projectId],
                        (current: { pages?: Array<{ items: ExportJob[] }> } | undefined) => current
                          ? {
                              ...current,
                              pages: current.pages?.map((page) => ({
                                ...page,
                                items: page.items.map((item) => item.id === job.id ? result.value : item),
                              })),
                            }
                          : current,
                      );
                      await jobs.refetch();
                    }, "已提交取消请求，请以任务状态为准")
                  }
                >
                  取消导出
                </button>
              )}
              {job.failure && (
                <p role="alert">
                  {job.failure.detail} · {job.failure.code}
                </p>
              )}
              {canEdit && ["failed", "cancelled"].includes(job.status) && (
                <button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => createExport(exportRequest(job), `retry-${job.id}`),
                      "已按原发布与原版本创建新的导出任务",
                    )
                  }
                >
                  重新导出固定版本
                </button>
              )}
            </article>
          ))}
        {jobs.hasNextPage && (
          <button
            disabled={jobs.isFetchingNextPage}
            onClick={() => void jobs.fetchNextPage()}
          >
            加载更多导出
          </button>
        )}
        {jobItems.length === 0 && <p>尚无文档导出任务。</p>}
      </section>
    </>
  );
}
function exportRequest(job: ExportJob): CreateExportJobRequest {
  return {
    releaseId: job.releaseId,
    format: job.format,
    packaging: job.packaging,
    selection: job.selection,
    options: job.options,
  };
}
function ProjectShares({
  projectId,
  owner,
  releases,
}: {
  projectId: string;
  owner: boolean;
  releases: ProjectRelease[];
}) {
  const api = useWorkbenchSharesApi(),
    action = useStudioAction();
  const [selection, setSelection] = useState(""),
    [expiry, setExpiry] = useState(""),
    [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["studio", "project-shares", projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listShareGrants(projectId, { cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: owner,
    refetchInterval: owner ? 5000 : false,
  });
  const options = releases
    .filter((release) => release.status === "ready")
    .flatMap((release) =>
      release.artifactPins
        .filter((pin) => pin.kind === "prototype")
        .map((pin) => ({
          release,
          pin,
          key: JSON.stringify([release.id, pin.artifactVersionId]),
        })),
    );
  const selected = options.find((option) => option.key === selection),
    shares = query.data?.pages.flatMap((page) => page.items) ?? [];
  const validLink =
    link &&
    shares.some(
      (share) =>
        share.id === link.id &&
        share.status === "active" &&
        (!share.expiresAt || Date.parse(share.expiresAt) > Date.now()),
    );
  return (
    <section aria-label="项目原型分享">
      <h2>项目原型分享</h2>
      {!owner ? (
        <p>项目级分享由所有者管理。原型版本分享位于“交付”。</p>
      ) : (
        <>
          <p>
            选择发布中的一个固定原型。生成新链接会撤销本项目已有的项目级链接；原型修订的独立分享仍在“交付”中管理。
          </p>
          <label>
            绑定版本
            <select
              aria-label="项目分享的固定原型"
              value={selection}
              onChange={(e) => {
                setSelection(e.target.value);
              }}
            >
              <option value="">选择已就绪发布中的原型</option>
              {options.map((option) => (
                <option key={option.key} value={option.key}>
                  发布 {option.release.version} · {option.pin.title} · 版本{" "}
                  {option.pin.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            到期时间（留空为长期有效）
            <input
              aria-label="项目分享到期时间"
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </label>
          <button
            disabled={action.busy || !selected}
            onClick={() =>
              void action.run(async () => {
                if (!selected) return;
                const expiresAt = expiry
                  ? new Date(expiry).toISOString()
                  : null;
                if (expiresAt && Date.parse(expiresAt) <= Date.now())
                  throw new Error("请选择未来的到期时间");
                const request = {
                    releaseId: selected.release.id,
                    artifactVersionId: selected.pin.artifactVersionId,
                    scope: "view" as const,
                    expiresAt,
                  },
                  signature = JSON.stringify({ projectId, request });
                if (intent.current?.signature !== signature)
                  intent.current = {
                    signature,
                    key: createIdempotencyKey("studio-share"),
                  };
                const result = await api.rotateShareGrant(
                  projectId,
                  request,
                  intent.current.key,
                );
                intent.current = null;
                setLink({
                  id: result.value.share.id,
                  url: `${window.location.origin}/share/${encodeURIComponent(result.value.token)}`,
                });
                await query.refetch();
              }, "新链接已生效，原项目级链接已撤销")
            }
          >
            生成链接并替换旧链接
          </button>
          {action.notice}
          {validLink && (
            <CopyableLink key={link.id} url={link.url} label="项目分享链接" />
          )}
          {query.isPending && <p role="status">正在读取分享…</p>}
          {query.error && (
            <p role="alert">
              分享记录读取失败。
              <button onClick={() => void query.refetch()}>重试项目分享</button>
            </p>
          )}
          {shares.map((share) => (
            <article className="studio-card" key={share.id}>
              <p>
                {shareStatus[share.status]} · 固定版本 {share.artifactVersionId}{" "}
                ·{" "}
                {share.expiresAt
                  ? `到期 ${new Date(share.expiresAt).toLocaleString()}`
                  : "长期有效"}
              </p>
              {share.status === "active" && link?.id !== share.id && (
                <p>
                  链接仅在生成时显示；需要新的可复制链接时，请重新选择上方固定版本并生成。
                </p>
              )}
            </article>
          ))}
          {query.hasNextPage && (
            <button
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多项目分享
            </button>
          )}
          {(query.data?.pages[0]?.activeCount ?? 0) > 0 && (
            <details>
              <summary>撤销项目级分享</summary>
              <p>所有现有项目级链接会立即失效。</p>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.revokeProjectShareGrants(projectId);
                    setLink(null);
                    await query.refetch();
                  }, "项目级分享已全部撤销")
                }
              >
                确认撤销所有项目级链接
              </button>
            </details>
          )}
        </>
      )}
    </section>
  );
}

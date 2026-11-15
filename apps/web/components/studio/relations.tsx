"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  ArtifactVersionRelations,
  Run,
} from "@workbench/workbench-contracts";
import {
  useWorkbenchArtifactsApi,
  useWorkbenchPrototypeV2Api,
  useWorkbenchRunsApi,
} from "@/lib/studio/api";
import { isActiveRun } from "@/lib/studio/run";

type Version = ArtifactVersionRelations["version"];
export function documentUrl(
  projectId: string,
  artifactId: string,
  artifactVersionId: string,
) {
  return `/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "documents", artifact: artifactId, artifactVersion: artifactVersionId })}`;
}
function VersionLink({
  projectId,
  version,
}: {
  projectId: string;
  version: Version;
}) {
  const revision = version.prototypeRevision;
  const href = revision
    ? `/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "pages", plan: revision.planId, revision: revision.id })}`
    : documentUrl(projectId, version.artifactId, version.artifactVersionId);
  return (
    <a href={href}>
      {version.title} · 版本 {version.version}
      {revision ? ` · 原型修订 ${revision.version}` : ""}
    </a>
  );
}
export function ArtifactRelations({
  projectId,
  artifactId,
  versionId,
}: {
  projectId: string;
  artifactId: string;
  versionId: string;
}) {
  const api = useWorkbenchArtifactsApi();
  const query = useInfiniteQuery({
    queryKey: [
      "studio",
      "artifact-relations",
      projectId,
      artifactId,
      versionId,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.getArtifactVersionRelations(artifactId, versionId, {
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page: ArtifactVersionRelations) =>
      page.nextCursor ?? undefined,
    enabled: Boolean(versionId),
  });
  const first = query.data?.pages[0],
    derived = query.data?.pages.flatMap((page) => page.derivedPrototypes) ?? [];
  return (
    <section className="studio-relations" aria-label="文档与原型关联">
      <h2>版本来源与关联</h2>
      {query.isPending && <p role="status">正在读取版本关联…</p>}
      {query.error && (
        <p role="alert">
          版本关联暂不可用。
          <button onClick={() => void query.refetch()}>重试关联</button>
        </p>
      )}
      {first?.version.createdByRunId && (
        <a
          href={`/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "runs", run: first.version.createdByRunId })}`}
        >
          查看生成运行
        </a>
      )}
      {first?.sourcePrd && (
        <p>
          固定来源 PRD：
          <VersionLink projectId={projectId} version={first.sourcePrd} />
        </p>
      )}
      {first?.version.prototypeRevision && (
        <p>
          原型页面：
          <VersionLink projectId={projectId} version={first.version} />
        </p>
      )}
      {first?.version.kind === "prd" && (
        <>
          {derived.length === 0 && <p>此 PRD 版本尚无已记录的关联原型。</p>}
          {derived.map((item) => (
            <p key={item.artifactVersionId}>
              {item.status === "ready" ? (
                <VersionLink projectId={projectId} version={item} />
              ) : (
                <span>
                  {item.title} · 版本 {item.version}
                </span>
              )}{" "}
              ·{" "}
              {item.status === "ready"
                ? "可用"
                : item.status === "staging"
                  ? "尚未发布"
                  : "生成未完成"}
            </p>
          ))}
          {query.hasNextPage && (
            <button
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多关联原型
            </button>
          )}
        </>
      )}
      {first?.version.kind === "prototype" && !first.sourcePrd && (
        <p>此原型未记录 PRD 来源。</p>
      )}
    </section>
  );
}
export function RevisionRelations({
  projectId,
  revisionId,
}: {
  projectId: string;
  revisionId: string;
}) {
  const api = useWorkbenchPrototypeV2Api();
  const query = useQuery({
    queryKey: ["studio", "revision-relations", projectId, revisionId],
    queryFn: () => api.revisionRelations(projectId, revisionId),
    enabled: Boolean(revisionId),
  });
  return (
    <section aria-label="原型需求来源">
      {query.isPending ? (
        <p role="status">正在读取需求来源…</p>
      ) : query.error ? (
        <p role="alert">
          需求来源暂不可用。
          <button onClick={() => void query.refetch()}>重试来源</button>
        </p>
      ) : query.data?.sourcePrd ? (
        <p>
          对应需求文档：
          <VersionLink projectId={projectId} version={query.data.sourcePrd} />
        </p>
      ) : (
        <p className="visual-muted">此版本未记录 PRD 来源。</p>
      )}
    </section>
  );
}
const outputLabels = {
  prd: "需求文档",
  prototype: "原型",
  image: "图片",
  code: "代码",
  document: "文档",
  data: "数据",
};
const stateLabels = {
  pending: "尚未生成",
  generating: "生成中草稿",
  ready: "已生成并可用",
  unpublished: "已有草稿，尚未发布",
  failed: "未完成",
  cancelled: "已停止",
};
export function RunOutputs({ run }: { run: Run }) {
  const api = useWorkbenchRunsApi();
  const query = useQuery({
    queryKey: ["studio", "run-outputs", run.projectId, run.id, run.status],
    queryFn: () => api.getRunOutputs(run.id),
    refetchInterval: isActiveRun(run) ? 3000 : false,
  });
  return (
    <section aria-label="分项产物状态">
      <h3>分项产物</h3>
      {query.isPending && <p role="status">正在读取各项产物状态…</p>}
      {query.error && (
        <p role="alert">
          产物状态读取失败。
          <button onClick={() => void query.refetch()}>重试产物状态</button>
        </p>
      )}
      {query.data?.items.map((item, index) => (
        <p key={item.version?.artifactVersionId ?? `${item.kind}-${index}`}>
          {outputLabels[item.kind]}：{stateLabels[item.state]}
          {item.state === "ready" && item.version && (
            <>
              {" "}
              · <VersionLink projectId={run.projectId} version={item.version} />
            </>
          )}
        </p>
      ))}
      {query.data?.coverage === "window" && (
        <p>仅载入当前产物窗口，不能据此认定全部产物完成。</p>
      )}
    </section>
  );
}

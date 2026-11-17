"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  ArtifactVersionRelations,
  PrototypeRevision,
  Run,
  RunArtifactTarget,
} from "@workbench/workbench-contracts";
import {
  useWorkbenchArtifactsApi,
  useWorkbenchPrototypeV2Api,
  useWorkbenchRunsApi,
} from "@/lib/studio/api";
import { isActiveRun } from "@/lib/studio/run";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { PrototypeVariants, type ArtifactPrompt } from "./prototype-variants";

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

function generationRunUrl(projectId: string, runId: string) {
  return `/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "runs", run: runId })}`;
}

function VariantSource({
  projectId,
  target,
}: {
  projectId: string;
  target: RunArtifactTarget;
}) {
  const api = useWorkbenchArtifactsApi();
  const protoApi = useWorkbenchPrototypeV2Api();
  const query = useQuery({
    queryKey: [
      "studio",
      "variant-source",
      projectId,
      target.artifactId,
      target.artifactVersionId,
    ],
    queryFn: async () => {
      const { version } = await api.getArtifactVersionRelations(
        target.artifactId,
        target.artifactVersionId,
        { limit: 1 },
      );
      if (
        version.artifactId !== target.artifactId ||
        version.artifactVersionId !== target.artifactVersionId
      )
        throw new Error("变体来源与固定版本不匹配");
      return version;
    },
  });
  const version = query.data;
  const revisionId = version?.prototypeRevision?.id ?? "";
  const revisionQuery = useQuery({
    queryKey: [...workbenchQueryKeys.prototypeV2(projectId), "revision", revisionId],
    queryFn: () => protoApi.getRevision(projectId, revisionId),
    // A name-only source summary must not download every frozen page and HTML.
    // Subscribe to the revision already opened in the workspace; the link below
    // loads the actual source when the user chooses to view it.
    enabled: false,
  });
  const cachedRevision = revisionQuery.data?.value;
  const matchingRevision =
    cachedRevision?.id === revisionId &&
    cachedRevision.projectId === projectId &&
    cachedRevision.planId === version?.prototypeRevision?.planId
      ? cachedRevision
      : undefined;
  const pageTitleById = new Map(
    (matchingRevision?.pages ?? []).map((p) => [p.id, p.title]),
  );
  return (
    <li>
      {version ? (
        <VersionLink projectId={projectId} version={version} />
      ) : (
        <a
          href={documentUrl(
            projectId,
            target.artifactId,
            target.artifactVersionId,
          )}
        >
          打开固定来源版本
        </a>
      )}
      {query.error && (
        <button onClick={() => void query.refetch()}>重试读取来源名称</button>
      )}
      <span> · 已选 {target.screenIds.length} 个页面</span>
      {version?.prototypeRevision && !matchingRevision && (
        <button
          type="button"
          disabled={revisionQuery.isFetching}
          onClick={() => void revisionQuery.refetch()}
        >
          {revisionQuery.isFetching
            ? "正在读取来源页面名称…"
            : revisionQuery.error
              ? "重试读取来源页面名称"
              : "显示来源页面名称"}
        </button>
      )}
      {version?.prototypeRevision ? (
        <ul>
          {target.screenIds.map((id) => {
            const pageTitle = pageTitleById.get(id);
            return (
              <li key={id}>
                <a
                  href={`/studio/${encodeURIComponent(projectId)}?${new URLSearchParams({ view: "pages", plan: version.prototypeRevision!.planId, revision: version.prototypeRevision!.id, page: id })}`}
                >
                  页面 {id}
                </a>
                {pageTitle ? <span> · {pageTitle}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>页面标识：{target.screenIds.join("、")}</p>
      )}
    </li>
  );
}

export function VariantSources({
  projectId,
  targets,
  intent,
}: {
  projectId: string;
  targets: Run["artifactTargets"];
  intent: Run["generationIntent"];
}) {
  if (intent !== "followup-design" && intent !== "interactive-prototype")
    return null;
  return (
    <section aria-label="固定变体来源">
      <h3>固定变体来源</h3>
      <ul>
        {targets.map((target) => (
          <VariantSource
            key={target.artifactVersionId}
            projectId={projectId}
            target={target}
          />
        ))}
      </ul>
    </section>
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
        <a href={generationRunUrl(projectId, first.version.createdByRunId)}>
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
  revision,
  pageId,
  onPrompt,
}: {
  projectId: string;
  revision: PrototypeRevision;
  pageId?: string;
  onPrompt?: ArtifactPrompt;
}) {
  const revisionId = revision.id;
  const api = useWorkbenchPrototypeV2Api();
  const query = useQuery({
    queryKey: ["studio", "revision-relations", projectId, revisionId],
    queryFn: async () => {
      const relations = await api.revisionRelations(projectId, revisionId);
      if (
        relations.revisionId !== revisionId ||
        (relations.sourceArtifact?.prototypeRevision &&
          relations.sourceArtifact.prototypeRevision.id !== revisionId)
      )
        throw new Error("原型来源与当前版本不匹配");
      return relations;
    },
    enabled: Boolean(revisionId),
  });
  const source = query.error ? undefined : query.data?.sourceArtifact;
  return (
    <section aria-label="原型需求来源">
      {query.isPending ? (
        <p role="status">正在读取需求来源…</p>
      ) : query.error ? (
        <p role="alert">
          <span>需求来源暂不可用。</span>
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
      {source?.status === "ready" && (
        <p>
          固定原型产物：
          <a
            href={documentUrl(
              projectId,
              source.artifactId,
              source.artifactVersionId,
            )}
          >
            {source.title} · 版本 {source.version}
          </a>
        </p>
      )}
      {source?.createdByRunId && (
        <p>
          <a href={generationRunUrl(projectId, source.createdByRunId)}>
            查看生成运行
          </a>
        </p>
      )}
      {onPrompt &&
        source?.kind === "prototype" &&
        source.status === "ready" &&
        source.schemaVersion === 1 &&
        ["ready", "confirmed", "rejected"].includes(revision.status) && (
          <PrototypeVariants
            key={revision.id}
            source={{
              artifactId: source.artifactId,
              artifactVersionId: source.artifactVersionId,
            }}
            versionTitle={`${revision.title} · 原型修订 ${revision.version}`}
            screens={revision.pages}
            initialScreenId={pageId}
            onPrompt={onPrompt}
          />
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

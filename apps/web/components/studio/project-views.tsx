"use client";
import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  Artifact,
  GenerationPreview,
  ProjectBootstrap,
  Run,
} from "@workbench/workbench-contracts";
import { useWorkbenchImportSourcesApi } from "@/lib/studio/api";
import { useWorkbenchProjectsApi } from "@/lib/studio/api";
import { useWorkbenchRunsApi } from "@/lib/studio/api";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import { useWorkbenchRunActions } from "@/lib/workbench/features/workbench-run-actions";
import { useWorkbenchRunController } from "@/lib/workbench/features/run-controller";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import type { StudioArtifactContext, StudioView } from "@/lib/studio/types";
import { useStudioAction } from "./actions";
import { ProjectPublishing } from "./project-publishing";
import { ContextImports, KnowledgeLibrary } from "./context-library";
import { Streamdown } from "streamdown";
import type { RunProjectionState } from "@/lib/workbench/run/reducer";
import { isActiveRun, projectedRun } from "@/lib/studio/run";
import { DocumentView } from "./document-view";
import { RunOutputs } from "./relations";
import { ProjectMembers } from "./project-members";
const uniqueItems = <T extends { id: string }>(items: T[]) => [
  ...new Map(items.map((item) => [item.id, item])).values(),
];
const etag = (v: { revision: number }) => `"${v.revision}"`;
export function ProjectViews({
  activeRunId,
  previews = [],
  view,
  bootstrap,
  canEdit,
  onPrompt,
}: {
  activeRunId?: string;
  previews?: GenerationPreview[];
  view: StudioView;
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
  onPrompt: (text: string, context?: StudioArtifactContext) => void;
}) {
  return (
    <div className="studio-view">
      {view === "documents" ? (
        <Documents
          activeRunId={activeRunId}
          previews={previews}
          bootstrap={bootstrap}
          canEdit={canEdit}
          onPrompt={onPrompt}
        />
      ) : view === "resources" || view === "knowledge" ? (
        <>
          <Resources
            projectId={bootstrap.project.id}
            canEdit={canEdit}
            knowledge={view === "knowledge"}
          />
          {view === "knowledge" ? (
            <KnowledgeLibrary bootstrap={bootstrap} canEdit={canEdit} />
          ) : (
            <ContextImports bootstrap={bootstrap} canEdit={canEdit} />
          )}
        </>
      ) : view === "runs" ? (
        <Runs bootstrap={bootstrap} canEdit={canEdit} />
      ) : view === "publishing" ? (
        <ProjectPublishing
          key={bootstrap.project.id}
          bootstrap={bootstrap}
          canEdit={canEdit}
        />
      ) : (
        <ProjectSettings bootstrap={bootstrap} canEdit={canEdit} />
      )}
    </div>
  );
}
function Resources({
  projectId,
  canEdit,
  knowledge,
}: {
  projectId: string;
  canEdit: boolean;
  knowledge: boolean;
}) {
  const api = useWorkbenchImportSourcesApi(),
    client = useQueryClient(),
    action = useStudioAction();
  const [kind, setKind] = useState<
      "url_snapshot" | "github_snapshot" | "figma_snapshot"
    >("url_snapshot"),
    [value, setValue] = useState(""),
    [ref, setRef] = useState("main");
  const importIntent = useRef<{ input: string; key: string } | null>(null);
  const query = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.importSources(projectId),
      "studio-infinite",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listImportSources(projectId, { limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.pages.some((page) =>
        page.items.some((source) => source.status === "pending"),
      )
        ? 5000
        : false,
  });
  const sources = uniqueItems(
    query.data?.pages.flatMap((page) => page.items) ?? [],
  );
  return (
    <>
      <h1>{knowledge ? "知识上下文" : "项目资料"}</h1>
      <p>
        {knowledge
          ? "选择已解析的资料作为生成依据。每次运行固定资料快照，修改源文件不会悄悄改变既有版本。"
          : "导入项目需要的资料，在输入框中选择引用。图片和文档可从底部附件上传。"}
      </p>
      {!knowledge && (
        <form
          className="studio-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const request =
                kind === "github_snapshot"
                  ? { kind, repository: value.trim(), ref: ref.trim() }
                  : kind === "figma_snapshot"
                    ? { kind, fileKey: value.trim() }
                    : { kind, sourceUrl: value.trim() };
              const input = JSON.stringify([projectId, request]);
              if (importIntent.current?.input !== input)
                importIntent.current = {
                  input,
                  key: `studio-import:${crypto.randomUUID()}`,
                };
              await api.createImportSource(
                projectId,
                request,
                importIntent.current.key,
              );
              importIntent.current = null;
              setValue("");
              await query.refetch();
              await client.invalidateQueries({
                queryKey: workbenchQueryKeys.importSources(projectId),
              });
            }, "导入已提交");
          }}
        >
          <select
            aria-label="资料类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="url_snapshot">网站快照</option>
            <option value="github_snapshot">GitHub 仓库</option>
            <option value="figma_snapshot">Figma 文件</option>
          </select>
          <input
            aria-label="资料地址"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === "github_snapshot"
                ? "owner/repository"
                : kind === "figma_snapshot"
                  ? "Figma 文件 key"
                  : "https://…"
            }
            required
          />
          {kind === "github_snapshot" && (
            <input
              aria-label="Git 分支"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
            />
          )}
          <button disabled={!canEdit || action.busy}>导入</button>
        </form>
      )}
      {action.notice}
      {query.error && (
        <p role="alert">
          {query.error.message}
          <button onClick={() => void query.refetch()}>重试</button>
        </p>
      )}
      <div className="studio-resource-list">
        {sources.map((source) => (
          <article key={source.id}>
            <div>
              <h2>{source.label}</h2>
              <p>
                {source.kind} ·{" "}
                {
                  {
                    pending: "正在解析",
                    ready: "可用于生成",
                    failed: "导入失败",
                    deleted: "已移除",
                  }[source.status]
                }
              </p>
              {source.failure && (
                <p className="studio-error">{source.failure.message}</p>
              )}
              {knowledge && source.checksum && (
                <small>内容校验：{source.checksum.slice(0, 16)}…</small>
              )}
            </div>
            {!knowledge && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.deleteImportSource(source.id, etag(source));
                    await client.invalidateQueries({
                      queryKey: workbenchQueryKeys.importSources(projectId),
                    });
                  }, "资料已从项目移除")
                }
              >
                移除
              </button>
            )}
          </article>
        ))}
      </div>
      {query.isPending && <p role="status">正在读取资料…</p>}
      {!query.isPending && !query.error && sources.length === 0 && (
        <p className="studio-empty-copy">
          尚无项目资料。上传附件或导入链接开始。
        </p>
      )}
      {query.hasNextPage && (
        <button
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多资料
        </button>
      )}
    </>
  );
}
function Documents({
  activeRunId,
  previews,
  bootstrap,
  canEdit,
  onPrompt,
}: {
  activeRunId?: string;
  previews: GenerationPreview[];
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
  onPrompt: (text: string, context?: StudioArtifactContext) => void;
}) {
  const params = useSearchParams(),
    selected = params.get("artifact") ?? "",
    requestedVersion = params.get("artifactVersion") ?? undefined;
  const api = useWorkbenchArtifactsApi();
  const [kind, setKind] = useState<Artifact["kind"] | "">("");
  const list = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.artifacts(bootstrap.project.id),
      "studio-infinite",
      kind,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listArtifacts(bootstrap.project.id, {
        limit: 30,
        cursor: pageParam,
        ...(kind ? { kind } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const artifacts = uniqueItems(
    list.data?.pages.flatMap((page) => page.items) ??
      bootstrap.artifacts.filter((item) => !kind || item.kind === kind),
  );
  const pinned = useQuery({
    queryKey: ["studio", "pinned-artifact", bootstrap.project.id, selected],
    enabled: Boolean(
      selected && !artifacts.some((item) => item.id === selected),
    ),
    queryFn: async () => {
      const result = await api.getArtifact(selected);
      if (result.value.projectId !== bootstrap.project.id)
        throw new Error("此产物不属于当前项目");
      return result.value;
    },
  });
  const artifact = selected
    ? (artifacts.find((a) => a.id === selected) ??
      (pinned.error ? undefined : pinned.data))
    : (artifacts.find(
        (a) => a.currentVersion?.createdByRunId === activeRunId,
      ) ?? artifacts[0]);
  return (
    <>
      <div className="studio-view-heading">
        <h1>文档与产物</h1>
        <label>
          产物类型
          <select
            aria-label="产物类型"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="">全部类型</option>
            {(
              [
                "prd",
                "document",
                "prototype",
                "image",
                "data",
                "code",
                "design_system",
              ] as const
            ).map((value) => (
              <option key={value} value={value}>
                {
                  {
                    prd: "需求文档",
                    document: "文档",
                    prototype: "原型",
                    image: "图片",
                    data: "数据",
                    code: "代码",
                    design_system: "设计系统",
                  }[value]
                }
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="选择文档"
          value={artifact?.id ?? ""}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("artifact", e.target.value);
            url.searchParams.delete("artifactVersion");
            window.history.pushState(null, "", url);
          }}
        >
          {artifacts.map((a) => (
            <option value={a.id} key={a.id}>
              {a.title} · {a.kind}
            </option>
          ))}
          {pinned.data &&
            !artifacts.some((item) => item.id === pinned.data.id) && (
              <option value={pinned.data.id}>
                {pinned.data.title} · 固定产物
              </option>
            )}
        </select>
      </div>
      {list.isPending && <p role="status">正在读取产物目录…</p>}
      {list.error && (
        <p role="alert">
          产物目录读取失败。
          <button onClick={() => void list.refetch()}>重试产物目录</button>
        </p>
      )}
      {list.hasNextPage && (
        <button
          disabled={list.isFetching}
          onClick={() => void list.fetchNextPage()}
        >
          加载更多产物
        </button>
      )}
      {previews
        .filter((p) => p.kind === "prd")
        .map((p) => (
          <article className="studio-document" key={p.artifactIndex}>
            <p role="status">生成中草稿 · 内容可能变化</p>
            <Streamdown>{p.markdown}</Streamdown>
          </article>
        ))}
      {artifact ? (
        <DocumentView
          key={`${artifact.id}:${requestedVersion ?? "current"}`}
          artifact={artifact}
          initialVersionId={requestedVersion}
          canEdit={canEdit}
          onPrompt={onPrompt}
        />
      ) : selected ? (
        pinned.error ? (
          <p role="alert">
            {pinned.error.message}
            <button onClick={() => void pinned.refetch()}>重试文档</button>
          </p>
        ) : (
          <p role="status">正在读取固定文档…</p>
        )
      ) : (
        <p className="studio-empty-copy">
          还没有文档。选择底部的“需求文档”或“文档＋原型”开始生成。
        </p>
      )}
    </>
  );
}
function Runs({
  bootstrap,
  canEdit,
}: {
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
}) {
  const api = useWorkbenchRunsApi(),
    projects = useWorkbenchProjectsApi();
  const params = useSearchParams(),
    requestedRunId = params.get("run") ?? "";
  const requestedThreadId =
    params.get("thread") ?? bootstrap.selectedThreadId ?? "";
  const threads = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.threadLists(bootstrap.project.id),
      "studio-infinite",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      projects.listThreads(bootstrap.project.id, {
        limit: 30,
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const threadItems = uniqueItems(
    threads.data?.pages.flatMap((page) => page.items) ?? bootstrap.threads,
  );
  const pinned = useQuery({
    queryKey: ["studio", "pinned-run", bootstrap.project.id, requestedRunId],
    enabled: Boolean(requestedRunId),
    queryFn: async () => {
      const result = await api.getRun(requestedRunId);
      if (result.projectId !== bootstrap.project.id)
        throw new Error("此运行不属于当前项目");
      return result;
    },
    refetchInterval: (query) =>
      !query.state.error && isActiveRun(query.state.data) ? 5000 : false,
  });
  const candidateThreadId = requestedRunId
    ? pinned.error
      ? ""
      : (pinned.data?.threadId ?? "")
    : requestedThreadId;
  const pinnedThread = useQuery({
    queryKey: [
      "studio",
      "pinned-thread",
      bootstrap.project.id,
      candidateThreadId,
    ],
    enabled:
      !!candidateThreadId &&
      !threadItems.some((item) => item.id === candidateThreadId),
    queryFn: async () => {
      const result = await projects.getThread(candidateThreadId);
      if (result.value.projectId !== bootstrap.project.id)
        throw new Error("此对话不属于当前项目");
      return result.value;
    },
  });
  const selectedThread =
    threadItems.find((item) => item.id === candidateThreadId) ??
    (pinnedThread.error ? undefined : pinnedThread.data);
  const threadId = selectedThread?.id ?? "";
  const list = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.runLists(bootstrap.project.id, threadId),
      "studio-infinite",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listRuns(threadId, { limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(threadId),
    refetchInterval: (query) =>
      !query.state.error && query.state.data?.pages[0]?.items.some(isActiveRun)
        ? 5000
        : false,
  });
  const runs = uniqueItems(
    list.data?.pages.flatMap((page) => page.items) ?? [],
  );
  const history = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.entryLists(bootstrap.project.id, threadId),
      "studio-infinite",
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      projects.listThreadEntries(threadId, {
        afterSequence: pageParam,
        limit: 100,
      }),
    getNextPageParam: (page) => page.nextAfterSequence ?? undefined,
    enabled: Boolean(threadId),
  });
  const entries = uniqueItems(
    history.data?.pages.flatMap((page) => page.items) ?? [],
  ).sort((a, b) => a.sequence - b.sequence);
  const run = requestedRunId
    ? pinned.error
      ? undefined
      : pinned.data
    : runs[0];
  return (
    <>
      <h1>运行与对话</h1>
      <div className="studio-inline-form">
        <select
          aria-label="对话"
          value={threadId}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.delete("run");
            url.searchParams.set("thread", e.target.value);
            window.history.pushState(null, "", url);
          }}
        >
          {threadItems.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || t.id}
            </option>
          ))}
          {selectedThread &&
            !threadItems.some((item) => item.id === selectedThread.id) && (
              <option value={selectedThread.id}>
                {selectedThread.title} · 固定对话
              </option>
            )}
        </select>
        <select
          aria-label="运行记录"
          value={run?.id ?? ""}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("run", e.target.value);
            window.history.pushState(null, "", url);
          }}
        >
          {runs.map((r) => (
            <option value={r.id} key={r.id}>
              {new Date(r.createdAt).toLocaleString()} · {r.status}
            </option>
          ))}
          {pinned.data && !runs.some((item) => item.id === pinned.data?.id) && (
            <option value={pinned.data.id}>
              固定运行 · {pinned.data.status}
            </option>
          )}
        </select>
      </div>
      {threads.hasNextPage && (
        <button
          disabled={threads.isFetching}
          onClick={() => void threads.fetchNextPage()}
        >
          加载更多对话
        </button>
      )}
      {list.hasNextPage && (
        <button
          disabled={list.isFetching}
          onClick={() => void list.fetchNextPage()}
        >
          加载更多运行
        </button>
      )}
      {threads.error && (
        <p role="alert">
          对话目录读取失败。
          <button onClick={() => void threads.refetch()}>重试对话目录</button>
        </p>
      )}
      {pinnedThread.error && (
        <p role="alert">
          {pinnedThread.error.message}
          <button onClick={() => void pinnedThread.refetch()}>
            重试固定对话
          </button>
        </p>
      )}
      {list.error && (
        <p role="alert">
          {list.error.message}
          <button onClick={() => void list.refetch()}>重试运行列表</button>
        </p>
      )}
      {requestedRunId && pinned.error && (
        <p role="alert">
          {pinned.error.message}
          <button onClick={() => void pinned.refetch()}>重试运行</button>
        </p>
      )}
      {run ? (
        <RunDetails key={run.id} run={run} canEdit={canEdit} />
      ) : (
        !pinned.error &&
        !pinnedThread.error && (
          <p>
            {requestedRunId || (list.isPending && !!threadId)
              ? "正在读取运行…"
              : "尚无运行记录。"}
          </p>
        )
      )}
      {threadId && (
        <section aria-label="完整对话历史">
          <h2>当前对话的全部消息</h2>
          <button
            disabled={history.isFetching}
            onClick={() => void history.refetch()}
          >
            刷新对话消息
          </button>
          <p>按发送顺序展示，包括用户输入和各次运行的回复。</p>
          {history.isPending && <p role="status">正在读取对话消息…</p>}
          {history.error && (
            <p role="alert">
              对话消息读取失败。
              <button onClick={() => void history.refetch()}>
                重试对话消息
              </button>
            </p>
          )}
          {entries.map((entry) => (
            <article className="studio-chat-message" key={entry.id}>
              <small>
                {
                  { user: "用户", assistant: "助手", system: "状态" }[
                    entry.role
                  ]
                }{" "}
                · {entry.sequence}
                {entry.producedByRunId && (
                  <button
                    onClick={() => {
                      const url = new URL(window.location.href);
                      url.searchParams.set("run", entry.producedByRunId!);
                      window.history.pushState(null, "", url);
                    }}
                  >
                    查看关联运行
                  </button>
                )}
              </small>
              {entry.content.type === "user.prompt" ||
              entry.content.type === "assistant.message" ? (
                <Streamdown>{entry.content.text}</Streamdown>
              ) : (
                <p>
                  {entry.content.type === "activity.status"
                    ? `${entry.content.label} · ${entry.content.status}`
                    : entry.content.prompt}
                </p>
              )}
            </article>
          ))}
          {history.hasNextPage && (
            <button
              disabled={history.isFetching}
              onClick={() => void history.fetchNextPage()}
            >
              加载后续消息
            </button>
          )}
          {!history.isPending && !history.error && entries.length === 0 && (
            <p>此对话尚无消息。</p>
          )}
        </section>
      )}
    </>
  );
}
type RunDetailsProps = {
  run: Run;
  canEdit: boolean;
  projection?: RunProjectionState | null;
  onRetried?: (run: Run) => void;
};
export function RunDetails(props: RunDetailsProps) {
  return props.projection !== undefined ? (
    <RunDetailsContent {...props} />
  ) : (
    <ConnectedRunDetails {...props} />
  );
}
function ConnectedRunDetails(props: RunDetailsProps) {
  const controller = useWorkbenchRunController({ run: props.run });
  return <RunDetailsContent {...props} projection={controller.projection} />;
}
function RunDetailsContent({
  run: snapshot,
  canEdit,
  projection,
  onRetried,
}: RunDetailsProps) {
  const run = projectedRun(snapshot, projection)!;
  const actions = useWorkbenchRunActions(run, onRetried),
    action = useStudioAction();
  const [answer, setAnswer] = useState("");
  const approval = actions.pendingApproval;
  return (
    <section className="studio-run-details">
      <p>
        状态：
        {run.status === "waiting_input"
          ? "等待补充输入"
          : run.phaseLabel || run.status}{" "}
        · 第 {run.attempt} 次执行
      </p>
      <small>运行编号：{run.id}</small>
      <RunOutputs run={run} />
      {action.notice}
      {run.failure && (
        <p role="alert">
          {run.failure.message} · 诊断 {run.failure.code}
        </p>
      )}
      <div className="studio-actions">
        {actions.canCancel && (
          <button
            disabled={!canEdit || actions.busy}
            onClick={() =>
              void action.run(actions.cancel, "停止请求已提交，等待运行确认")
            }
          >
            停止运行
          </button>
        )}
        {actions.canRetry && (
          <button
            disabled={!canEdit || actions.busy}
            onClick={() => void action.run(actions.retry, "重试已提交")}
          >
            重试
          </button>
        )}
      </div>
      {Boolean(actions.approvalsError) && (
        <p role="alert">
          确认问题加载失败
          <button onClick={() => void action.run(actions.retryApprovals)}>
            重试加载
          </button>
        </p>
      )}
      {approval && (
        <div className="studio-approval">
          <h2>需要你的确认</h2>
          <p>{approval.prompt}</p>
          {approval.options.map((option) => (
            <button
              key={option.id}
              disabled={!canEdit || actions.busy}
              onClick={() =>
                void action.run(
                  () => actions.submitApproval("submit", option.value),
                  "回答已提交",
                )
              }
            >
              {option.label}
            </button>
          ))}
          {!approval.options.length && (
            <>
              <textarea
                aria-label="补充输入"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button
                disabled={!canEdit || actions.busy || !answer.trim()}
                onClick={() =>
                  void action.run(
                    () => actions.submitApproval("submit", answer),
                    "回答已提交",
                  )
                }
              >
                提交回答
              </button>
              <button
                disabled={!canEdit || actions.busy}
                onClick={() =>
                  void action.run(
                    () => actions.submitApproval("approve"),
                    "已批准",
                  )
                }
              >
                批准
              </button>
              <button
                disabled={!canEdit || actions.busy}
                onClick={() =>
                  void action.run(
                    () => actions.submitApproval("reject"),
                    "已拒绝",
                  )
                }
              >
                拒绝
              </button>
            </>
          )}
        </div>
      )}
      {Object.values(projection?.activities ?? {}).map((activity) => (
        <p key={activity.activityId}>
          {activity.label} · {activity.status}
        </p>
      ))}
      {Object.values(projection?.messages ?? {}).map((message) => (
        <article key={message.entryId} className="studio-chat-message">
          {message.text}
        </article>
      ))}
    </section>
  );
}
function ProjectSettings({
  bootstrap,
  canEdit,
}: {
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
}) {
  const api = useWorkbenchProjectsApi(),
    client = useQueryClient(),
    router = useRouter(),
    action = useStudioAction(),
    project = bootstrap.project;
  const [title, setTitle] = useState(project.title);
  const refresh = () =>
    client.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstraps(project.id),
    });
  return (
    <>
      <h1>项目设置</h1>
      <label>
        项目名称
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={240}
        />
      </label>
      <div className="studio-actions">
        <button
          disabled={!canEdit || action.busy || !title.trim()}
          onClick={() =>
            void action.run(async () => {
              await api.updateProject(
                project.id,
                { title: title.trim() },
                etag(project),
              );
              await refresh();
            }, "名称已保存")
          }
        >
          保存名称
        </button>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const result = await api.duplicateProject(project.id);
              router.push(`/studio/${result.value.project.id}`);
            }, "项目已复制")
          }
        >
          复制项目
        </button>
        <details>
          <summary>归档项目</summary>
          <p>归档后项目将从可用列表移除。</p>
          <button
            disabled={bootstrap.access.role !== "owner" || action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.archiveProject(project.id, etag(project));
                router.push("/");
              }, "项目已归档")
            }
          >
            确认归档
          </button>
        </details>
      </div>
      {action.notice}
      <ProjectMembers key={project.id} bootstrap={bootstrap} />
    </>
  );
}

"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import type {
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
import { projectedRun } from "@/lib/studio/run";
import { DocumentView } from "./document-view";
import { RunOutputs } from "./relations";
import { ProjectMembers } from "./project-members";
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
  const query = useQuery({
    queryKey: workbenchQueryKeys.importSources(projectId),
    queryFn: () => api.listImportSources(projectId, { limit: 100 }),
    refetchInterval: 5000,
  });
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
              await api.createImportSource(
                projectId,
                kind === "github_snapshot"
                  ? { kind, repository: value, ref }
                  : kind === "figma_snapshot"
                    ? { kind, fileKey: value }
                    : { kind, sourceUrl: value },
              );
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
        {query.data?.items.map((source) => (
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
      {query.data?.items.length === 0 && (
        <p className="studio-empty-copy">
          尚无项目资料。上传附件或导入链接开始。
        </p>
      )}
      {query.data?.nextCursor && <p>当前显示最近 100 项资料。</p>}
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
  const artifacts = bootstrap.artifacts.filter((a) =>
    [
      "prd",
      "document",
      "data",
      "image",
      "code",
      "design_system",
      "prototype",
    ].includes(a.kind),
  );
  const params = useSearchParams(),
    selected = params.get("artifact") ?? "",
    requestedVersion = params.get("artifactVersion") ?? undefined;
  const api = useWorkbenchArtifactsApi();
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
    ? (artifacts.find((a) => a.id === selected) ?? pinned.data)
    : (artifacts.find(
        (a) => a.currentVersion?.createdByRunId === activeRunId,
      ) ?? artifacts[0]);
  return (
    <>
      <div className="studio-view-heading">
        <h1>文档与产物</h1>
        <select
          aria-label="选择文档"
          value={artifact?.id ?? ""}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("artifact", e.target.value);
            url.searchParams.delete("artifactVersion");
            window.history.pushState(window.history.state, "", url);
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
  const [manualThreadId, setThread] = useState(
    bootstrap.selectedThreadId ?? "",
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
  });
  const threadId = requestedRunId
    ? (pinned.data?.threadId ?? "")
    : manualThreadId;
  const list = useQuery({
    queryKey: ["studio", "runs", bootstrap.project.id, threadId],
    queryFn: () => api.listRuns(threadId, { limit: 100 }),
    enabled: Boolean(threadId),
    refetchInterval: 5000,
  });
  const history = useQuery({
    queryKey: ["studio", "thread-history", bootstrap.project.id, threadId],
    queryFn: () => projects.getProjectBootstrap(bootstrap.project.id, threadId),
    enabled: Boolean(threadId),
    refetchInterval: 5000,
  });
  const run = requestedRunId ? pinned.data : list.data?.items[0];
  return (
    <>
      <h1>运行与对话</h1>
      <div className="studio-inline-form">
        <select
          aria-label="对话"
          value={threadId}
          onChange={(e) => {
            setThread(e.target.value);
            const url = new URL(window.location.href);
            url.searchParams.delete("run");
            window.history.pushState(window.history.state, "", url);
          }}
        >
          {bootstrap.threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title || t.id}
            </option>
          ))}
          {pinned.data &&
            !bootstrap.threads.some(
              (item) => item.id === pinned.data?.threadId,
            ) && (
              <option value={pinned.data.threadId}>固定运行的来源对话</option>
            )}
        </select>
        <select
          aria-label="运行记录"
          value={run?.id ?? ""}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("run", e.target.value);
            window.history.pushState(window.history.state, "", url);
          }}
        >
          {list.data?.items.map((r) => (
            <option value={r.id} key={r.id}>
              {new Date(r.createdAt).toLocaleString()} · {r.status}
            </option>
          ))}
          {pinned.data &&
            !list.data?.items.some((item) => item.id === pinned.data?.id) && (
              <option value={pinned.data.id}>
                固定运行 · {pinned.data.status}
              </option>
            )}
        </select>
      </div>
      {list.error && <p role="alert">{list.error.message}</p>}
      {requestedRunId && pinned.error && (
        <p role="alert">
          {pinned.error.message}
          <button onClick={() => void pinned.refetch()}>重试运行</button>
        </p>
      )}
      {run ? (
        <>
          <RunDetails key={run.id} run={run} canEdit={canEdit} />
          <h2>历史对话</h2>
          {history.data?.value.entries
            .filter((entry) => entry.producedByRunId === run.id)
            .map((entry) => (
              <article className="studio-chat-message" key={entry.id}>
                {entry.content.type === "user.prompt" ||
                entry.content.type === "assistant.message"
                  ? entry.content.text
                  : entry.content.type === "activity.status"
                    ? `${entry.content.label} · ${entry.content.status}`
                    : entry.content.prompt}
              </article>
            ))}
        </>
      ) : (
        !pinned.error && (
          <p>{requestedRunId ? "正在读取固定运行…" : "尚无运行记录。"}</p>
        )
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

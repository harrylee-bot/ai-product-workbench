"use client";
import { useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sourcePrototypeInputSchema,
  designSystemDocumentSchema,
  type ProjectBootstrap,
  type Artifact,
} from "@workbench/workbench-contracts";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import { useWorkbenchDesignSystemsApi } from "@/lib/studio/api";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { useStudioAction } from "./actions";

export function ContextImports({
  bootstrap,
  canEdit,
}: {
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
}) {
  const artifacts = useWorkbenchArtifactsApi(),
    designs = useWorkbenchDesignSystemsApi(),
    client = useQueryClient(),
    action = useStudioAction();
  const [title, setTitle] = useState(""),
    [color, setColor] = useState("#2563eb"),
    [principle, setPrinciple] = useState("");
  const projectId = bootstrap.project.id;
  const imports = useRef({ projectId, keys: new Map<string, string>() });
  if (imports.current.projectId !== projectId) imports.current = { projectId, keys: new Map() };
  const [imported, setImported] = useState({ projectId, versions: new Set<string>() });
  const catalog = useInfiniteQuery({
    queryKey: ["studio", "design-catalog", bootstrap.project.workspaceId, "infinite"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      designs.listDesignSystemCatalog(bootstrap.project.workspaceId, { cursor: pageParam, limit: 30 }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 30000,
  });
  const catalogItems = [...new Map((catalog.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.artifactVersionId, item])).values()];
  const refresh = () =>
    client.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstraps(bootstrap.project.id),
    });
  const importFile = async (file: File, kind: "prototype" | "design") => {
    if (file.size > 2 * 1024 * 1024)
      throw new Error("导入文件超过 2 MB，请检查文件内容");
    const data = JSON.parse(await file.text());
    if (kind === "prototype") {
      const document = sourcePrototypeInputSchema.parse(data);
      await artifacts.createArtifact(bootstrap.project.id, {
        kind: "prototype",
        title: document.title,
        document,
      });
    } else {
      const document = designSystemDocumentSchema.parse(data);
      await designs.createDesignSystem(bootstrap.project.id, {
        title: document.title,
        document,
      });
    }
    await refresh();
  };
  return (
    <section className="studio-context-library">
      <h2>源码原型与设计系统</h2>
      {action.notice}
      <div className="studio-actions">
        <label>
          导入源码原型 JSON
          <input
            aria-label="导入源码原型 JSON"
            type="file"
            accept=".json,application/json"
            disabled={!canEdit || action.busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action.run(
                  () => importFile(file, "prototype"),
                  "源码原型已导入，可在文档与产物中打开",
                );
              e.target.value = "";
            }}
          />
        </label>
        <label>
          导入设计系统 JSON
          <input
            aria-label="导入设计系统 JSON"
            type="file"
            accept=".json,application/json"
            disabled={!canEdit || action.busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action.run(
                  () => importFile(file, "design"),
                  "设计系统已导入",
                );
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <details>
        <summary>创建自定义设计系统</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await designs.createDesignSystem(bootstrap.project.id, {
                title,
                document: {
                  protocol: "workbench.design-system.v1",
                  documentId: `design-${crypto.randomUUID()}`,
                  title,
                  tokens: [
                    {
                      id: "primary",
                      path: "color.primary",
                      type: "color",
                      value: { kind: "literal", value: color },
                      description: "主要交互色",
                    },
                  ],
                  assets: [],
                  principles: principle
                    ? [
                        {
                          id: "principle",
                          title: "设计方向",
                          description: principle,
                        },
                      ]
                    : [],
                  guidelines: [],
                  components: [],
                },
              });
              setTitle("");
              await refresh();
            }, "设计系统已创建，可在输入框中选择");
          }}
        >
          <label>
            名称
            <input
              required
              maxLength={240}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            主题色
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <label>
            设计原则
            <textarea
              maxLength={4000}
              value={principle}
              onChange={(e) => setPrinciple(e.target.value)}
            />
          </label>
          <button disabled={!canEdit || action.busy}>创建设计系统</button>
        </form>
      </details>
      <details>
        <summary>从工作区设计库导入</summary>
        {catalog.error && (
          <p role="alert">
            {catalog.error.message}
            <button disabled={catalog.isFetching} onClick={() => void (catalog.isFetchNextPageError ? catalog.fetchNextPage({ cancelRefetch: false }) : catalog.refetch())}>重试加载设计库</button>
          </p>
        )}
        {catalog.isPending && (
          <p>正在加载…</p>
        )}
        <p>已载入 {catalogItems.length} 项设计</p>
        {catalogItems.map((item) => (
            <div className="studio-card" key={item.artifactVersionId}>
              <strong>{item.artifactTitle}</strong>
              <p>
                {item.projectTitle} · 版本 {item.version}
              </p>
              <button
                disabled={!canEdit || action.busy || imported.projectId === projectId && imported.versions.has(item.artifactVersionId)}
                onClick={() =>
                  void action.run(async () => {
                    const scope = imports.current;
                    let key = scope.keys.get(item.artifactVersionId);
                    if (!key) { key = `studio-design-import:${crypto.randomUUID()}`; scope.keys.set(item.artifactVersionId, key); }
                    await designs.importDesignSystem(projectId, {
                      sourceArtifactVersionId: item.artifactVersionId,
                    }, key);
                    if (imports.current !== scope) return;
                    setImported(current => ({ projectId, versions: new Set([...(current.projectId === projectId ? current.versions : []), item.artifactVersionId]) }));
                    await refresh();
                  }, "设计系统已加入项目")
                }
              >
                {imported.projectId === projectId && imported.versions.has(item.artifactVersionId) ? "已加入项目" : "加入项目"}
              </button>
            </div>
        ))}
        {catalog.hasNextPage && <button disabled={catalog.isFetching} onClick={() => void catalog.fetchNextPage({ cancelRefetch: false })}>{catalog.isFetchingNextPage ? "正在加载设计…" : "加载更多设计"}</button>}
      </details>
    </section>
  );
}

export function KnowledgeLibrary({
  bootstrap,
  canEdit,
}: {
  bootstrap: ProjectBootstrap;
  canEdit: boolean;
}) {
  const artifacts = bootstrap.artifacts.filter(
    (artifact) => artifact.currentVersion?.status === "ready",
  );
  const [selected, setSelected] = useState("");
  const artifact = artifacts.find((a) => a.id === selected) ?? artifacts[0];
  return (
    <section>
      <h2>项目知识入库</h2>
      <p>确认固定版本后写入本项目知识库。撤回不会删除原始产物版本。</p>
      <select
        aria-label="知识产物"
        value={artifact?.id ?? ""}
        onChange={(e) => setSelected(e.target.value)}
      >
        {artifacts.map((a) => (
          <option value={a.id} key={a.id}>
            {a.title} · 版本 {a.currentVersion!.version}
          </option>
        ))}
      </select>
      {artifact ? (
        <KnowledgeVersion
          key={artifact.currentVersion!.artifactVersionId}
          artifact={artifact}
          canEdit={canEdit}
        />
      ) : (
        <p>尚无可确认的产物版本。</p>
      )}
    </section>
  );
}
function KnowledgeVersion({
  artifact,
  canEdit,
}: {
  artifact: Artifact;
  canEdit: boolean;
}) {
  const api = useWorkbenchArtifactsApi(),
    action = useStudioAction(),
    version = artifact.currentVersion!;
  const state = useQuery({
    queryKey: [
      "studio",
      "finalization",
      artifact.id,
      version.artifactVersionId,
    ],
    queryFn: () => api.getFinalization(artifact.id, version.artifactVersionId),
    refetchInterval: 5000,
  });
  return (
    <div className="studio-card">
      {action.notice}
      {state.error ? (
        <p role="alert">{state.error.message}</p>
      ) : state.isPending ? (
        <p>正在加载…</p>
      ) : (
        <>
          <p>
            知识状态：{state.data?.status ?? "未确认"}
            {state.data?.ingestionJob && ` · ${state.data.ingestionJob.status}`}
          </p>
          {state.data?.ingestionJob?.errorCode && (
            <p role="alert">处理失败：{state.data.ingestionJob.errorCode}</p>
          )}
          <div className="studio-actions">
            {(!state.data || state.data.status === "withdrawn") && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.confirmFinalization(
                      artifact.id,
                      version.artifactVersionId,
                      version.checksum,
                    );
                    await state.refetch();
                  }, "固定版本已确认，等待知识处理")
                }
              >
                确认并加入项目知识
              </button>
            )}
            {state.data?.ingestionJob?.status === "failed" && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.retryFinalization(
                      artifact.id,
                      version.artifactVersionId,
                    );
                    await state.refetch();
                  }, "重试已提交")
                }
              >
                重试入库
              </button>
            )}
            {state.data && state.data.status !== "withdrawn" && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.withdrawFinalization(
                      artifact.id,
                      version.artifactVersionId,
                    );
                    await state.refetch();
                  }, "知识版本已撤回")
                }
              >
                撤回知识版本
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

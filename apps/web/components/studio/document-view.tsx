"use client";
import type { StudioArtifactContext } from "@/lib/studio/types";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  prdDocumentSchema,
  runPrdScreenPlanSchema,
  type Artifact,
  type JsonValue,
} from "@workbench/workbench-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import { StructuredContent, SourcePreview } from "./content";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { useStudioAction, saveBlob, verifyDownload } from "./actions";
import { ArtifactRelations } from "./relations";
const hidden = new Set([
  "protocol",
  "schemaVersion",
  "id",
  "documentId",
  "citations",
  "revision",
  "source",
  "createdAt",
  "updatedAt",
  "changedAt",
  "checksum",
  "kind",
  "type",
  "status",
  "nodeId",
  "pageId",
  "artifactId",
  "artifactVersionId",
  "sourceRefs",
  "metadata",
]);
const editable = new Set([
  "title",
  "text",
  "description",
  "summary",
  "notes",
  "markdown",
  "content",
]);
export function DocumentView({
  artifact,
  canEdit,
  onPrompt,
  initialVersionId,
}: {
  artifact: Artifact;
  canEdit: boolean;
  onPrompt: (text: string, context?: StudioArtifactContext) => void;
  initialVersionId?: string;
}) {
  const api = useWorkbenchArtifactsApi(),
    client = useQueryClient(),
    action = useStudioAction();
  const [selected, setSelected] = useState(initialVersionId ?? ""),
    [screenNames, setScreenNames] = useState(""),
    [draft, setDraft] = useState<JsonValue | null>(null),
    [editing, setEditing] = useState(false);
  const versions = useQuery({
    queryKey: ["studio", "artifact-versions", artifact.id],
    queryFn: () => api.listArtifactVersions(artifact.id, { limit: 100 }),
  });
  const versionId =
    selected || artifact.currentVersion?.artifactVersionId || "";
  const detail = useQuery({
    queryKey: workbenchQueryKeys.artifactVersion(
      artifact.projectId,
      artifact.id,
      versionId,
    ),
    queryFn: () => api.getArtifactVersion(artifact.id, versionId),
    enabled: Boolean(versionId),
  });
  const value = detail.data?.value,
    content =
      draft ??
      (value?.contentMode === "inline"
        ? (value.content as unknown as JsonValue)
        : null);
  const update = (path: (string | number)[], text: string) => {
    if (content === null) return;
    const copy = structuredClone(content);
    let parent = copy as Record<string, unknown>;
    for (const part of path.slice(0, -1))
      parent = parent[part] as Record<string, unknown>;
    parent[path.at(-1)!] = text;
    setDraft(copy);
  };
  const render = (
    data: JsonValue,
    path: (string | number)[] = [],
    depth = 0,
  ): ReactNode => {
    if (data === null || typeof data === "boolean") return null;
    if (typeof data === "string")
      return editing && editable.has(String(path.at(-1))) ? (
        <textarea
          key={path.join(".")}
          aria-label={`编辑 ${path.join(" / ")}`}
          value={data}
          onChange={(e) => update(path, e.target.value)}
        />
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{data}</ReactMarkdown>
      );
    if (typeof data === "number") return <span>{data}</span>;
    if (Array.isArray(data))
      return (
        <div className="studio-document-blocks">
          {data.map((item, i) => (
            <div key={i}>{render(item, [...path, i], depth + 1)}</div>
          ))}
        </div>
      );
    if (typeof data.text === "string" && !editing)
      return <span>{data.text}</span>;
    return (
      <section className={depth < 2 ? "studio-document-section" : ""}>
        {Object.entries(data)
          .filter(([key]) => !hidden.has(key))
          .map(([key, item]) => (
            <div key={key}>
              {key === "title" && !editing ? (
                <h2>{String(item)}</h2>
              ) : (
                render(item, [...path, key], depth + 1)
              )}
            </div>
          ))}
      </section>
    );
  };
  return (
    <>
      <div className="studio-actions">
        <select
          aria-label="文档版本"
          value={versionId}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("artifact", artifact.id);
            url.searchParams.set("artifactVersion", e.target.value);
            window.history.pushState(window.history.state, "", url);
            setSelected(e.target.value);
            setDraft(null);
            setEditing(false);
          }}
        >
          {versions.data?.items.map((v) => (
            <option value={v.artifactVersionId} key={v.artifactVersionId}>
              版本 {v.version} · {v.status}
            </option>
          ))}
        </select>
        {value?.kind === "prd" && value.contentMode === "inline" && (
          <>
            <button
              disabled={!canEdit || action.busy}
              onClick={() => {
                setDraft(value.content as unknown as JsonValue);
                setEditing(!editing);
              }}
            >
              编辑文档
            </button>
            {editing && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const current = await api.getArtifact(artifact.id);
                    const document = prdDocumentSchema.parse(content);
                    const next = await api.createArtifactVersion(
                      artifact.id,
                      {
                        kind: "prd",
                        baseArtifactVersionId: versionId,
                        document,
                      },
                      current.etag,
                    );
                    setSelected(next.value.artifactVersionId);
                    setDraft(null);
                    setEditing(false);
                    await versions.refetch();
                    await client.invalidateQueries({
                      queryKey: workbenchQueryKeys.bootstraps(
                        artifact.projectId,
                      ),
                    });
                  }, "已保存为新版本")
                }
              >
                保存新版本
              </button>
            )}
          </>
        )}
        <button
          disabled={!canEdit || !versionId || artifact.kind === "design_system"}
          onClick={() => {
            if (artifact.kind === "design_system") return;
            onPrompt(`完善《${artifact.title}》：`, {
              title: `${artifact.title} · 版本 ${value?.version ?? ""}`,
              workflow: "edit",
              artifactTargets: [
                {
                  artifactId: artifact.id,
                  artifactVersionId: versionId,
                  screenIds: [],
                },
              ],
              requestedArtifactKinds: [artifact.kind],
            });
          }}
        >
          继续完善此版本
        </button>
        {value?.contentMode === "blob" && (
          <button
            onClick={() =>
              void action.run(async () => {
                const result = await api.getArtifactVersionContent(
                  artifact.id,
                  versionId,
                );
                await verifyDownload(result, {
                  sha256: value.blob.sha256,
                  size: value.blob.byteSize,
                });
                saveBlob(result, value.blob.fileName || artifact.title);
              }, "已向浏览器发起下载")
            }
          >
            下载原文件
          </button>
        )}
      </div>
      {value?.kind === "prd" && value.contentMode === "inline" && (
        <section className="studio-document">
          <h2>从此需求版本生成界面</h2>
          <p>
            固定已保存的版本 {value.version}。填写一行生成单屏，填写 2–12
            行生成连贯流程；进入计划后审阅完整输入再开始。
          </p>
          <label>
            页面范围（每行一个页面名称）
            <textarea
              aria-label="PRD 生成页面范围"
              value={screenNames}
              onChange={(event) => setScreenNames(event.target.value)}
              placeholder="订单列表\n订单详情\n提交结果"
            />
          </label>
          {editing && <p>请先保存或退出文档编辑，再基于固定版本生成。</p>}
          <div className="studio-actions">
            {(["prd-prototype", "prd-flow"] as const).map((intent) => (
              <button
                key={intent}
                disabled={
                  !canEdit || editing || value.status !== "ready" || action.busy
                }
                onClick={() =>
                  void action.run(async () => {
                    const screens = runPrdScreenPlanSchema.parse(
                      screenNames
                        .split("\n")
                        .map((name) => name.trim())
                        .filter(Boolean)
                        .map((title, index) => ({
                          id: `screen-${index + 1}`,
                          title,
                        })),
                    );
                    if (
                      intent === "prd-prototype"
                        ? screens.length !== 1
                        : screens.length < 2
                    )
                      throw new Error(
                        intent === "prd-prototype"
                          ? "单屏界面请填写一个页面名称"
                          : "多屏流程请填写 2–12 个页面名称",
                      );
                    onPrompt(
                      `基于固定的《${artifact.title}》版本 ${value.version}，生成${intent === "prd-flow" ? "有真实跨页交互的流程" : "可操作的界面"}：${screens.map((screen) => screen.title).join(" → ")}。`,
                      {
                        title: `${artifact.title} · 版本 ${value.version}`,
                        workflow: "generate",
                        generationIntent: intent,
                        prdScreenPlan: screens,
                        artifactTargets: [
                          {
                            artifactId: artifact.id,
                            artifactVersionId: versionId,
                            screenIds: [],
                          },
                        ],
                        requestedArtifactKinds: ["prototype"],
                      },
                    );
                  }, "已将固定需求版本和页面范围放入输入框")
                }
              >
                {intent === "prd-prototype"
                  ? "基于此 PRD 生成界面"
                  : "生成多屏流程"}
              </button>
            ))}
          </div>
        </section>
      )}
      {action.notice}
      {value && (value.kind === "prd" || value.kind === "prototype") && (
        <ArtifactRelations
          projectId={artifact.projectId}
          artifactId={artifact.id}
          versionId={versionId}
        />
      )}
      {detail.error && <p role="alert">{detail.error.message}</p>}
      {detail.isPending && <p>正在加载文档…</p>}
      {value?.kind === "prototype" && value.schemaVersion === 2 ? (
        <SourcePreview
          title={artifact.title}
          create={() =>
            api.createSourcePrototypePreviewToken(artifact.id, versionId)
          }
        />
      ) : (
        content !== null && (
          <article className="studio-document">
            {editing ? render(content) : <StructuredContent value={content} />}
          </article>
        )
      )}
    </>
  );
}

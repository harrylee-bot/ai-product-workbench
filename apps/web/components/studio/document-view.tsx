"use client";
import type { StudioArtifactContext } from "@/lib/studio/types";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  prdDocumentSchema,
  type Artifact,
  type JsonValue,
} from "@workbench/workbench-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import { StructuredContent, SourcePreview } from "./content";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { useStudioAction, saveBlob } from "./actions";
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
}: {
  artifact: Artifact;
  canEdit: boolean;
  onPrompt: (text: string, context?: StudioArtifactContext) => void;
}) {
  const api = useWorkbenchArtifactsApi(),
    client = useQueryClient(),
    action = useStudioAction();
  const [selected, setSelected] = useState(""),
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
                saveBlob(result, artifact.title);
              }, "已向浏览器发起下载")
            }
          >
            下载原文件
          </button>
        )}
      </div>
      {action.notice}
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

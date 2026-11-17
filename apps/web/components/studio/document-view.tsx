"use client";
import type { StudioArtifactContext } from "@/lib/studio/types";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  prdDocumentSchema,
  prdTableOfContentsEntriesForV3,
  type PrdDocument,
  prdChannelRowSchema,
  prdSafetyBaselineRowSchema,
  prdTemplateDiagramSchema,
  jsonValueSchema,
  canonicalJson,
  runPrdScreenPlanSchema,
  type Artifact,
  type JsonValue,
} from "@workbench/workbench-contracts";
import { z } from "zod";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  studioRecordKey,
  useStudioStoredRecord,
} from "@/lib/studio/stored-record";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import {
  StructuredContent,
  PrototypeArtifactPreview,
  VerifiedBlobContent,
} from "./content";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { useStudioAction } from "./actions";
import {
  PrdChannels,
  PrdSafetyBaseline,
  PrdDiagram,
  PrdCover,
  PrdVersionHistory,
} from "./prd-semantics";
import { ImageEditor } from "./image-editor";
import { ArtifactRelations } from "./relations";
import { ArtifactLinks } from "./artifact-links";
import { PrototypeVariants } from "./prototype-variants";
const documentDraftRecordSchema = z
  .object({
    version: z.literal(1),
    baseChecksum: z.string(),
    draft: jsonValueSchema,
    conflict: z.literal(true).optional(),
    baseline: z.object({
      artifactVersionId: z.string(),
      etag: z.string(),
      document: prdDocumentSchema,
    }).strict().optional(),
    prepared: z
      .object({
        signature: z.string(),
        key: z.string(),
        etag: z.string(),
        document: prdDocumentSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
function parsePrdDraft(value: JsonValue): PrdDocument {
  const parsed = prdDocumentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const messages = parsed.error.issues.map((issue) => {
    const path = issue.path.map(String);
    if (path.includes("channelTable"))
      return "投放渠道需与使用场景正文一致，请在正文明确说明启用的渠道";
    if (path.includes("safetyBaseline")) {
      const row = Number(path[path.indexOf("rows") + 1]);
      return `第${Number.isFinite(row) ? row + 1 : "相关"}项安全基线的判定、备注与正文需一致；是/否必须有对应事实与依据`;
    }
    if (path[0] === "versionHistory")
      return "修订记录的作者、参与者、日期与说明需完整";
    if (path[0] === "cover" || path[0] === "title")
      return "请填写完整工单名称，封面和文档标题将自动同步";
    return "请检查正文是否完整，以及章节编号、图示和目录是否一致";
  });
  throw new Error(
    `文档尚不能保存：${[...new Set(messages)].slice(0, 4).join("；")}。草稿已保留。`,
  );
}
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
const fixedPrdTitles = new Set([
  "title",
  "cover.title",
  "tableOfContents.title",
  "sections.introduction.title",
  "sections.introduction.background.title",
  "sections.introduction.scope.title",
  "sections.introduction.usageScenarios.title",
  "sections.businessRequirements.title",
  "sections.businessRequirements.pageLinks.title",
  "sections.degradation.title",
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
  const { user } = useWorkbenchAuth();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [editingImage, setEditingImage] = useState(false);
  const [selected, setSelected] = useState(
      initialVersionId ?? artifact.currentVersion?.artifactVersionId ?? "",
    ),
    [screenNames, setScreenNames] = useState(""),
    [draft, setDraft] = useState<JsonValue | null>(null),
    [editing, setEditing] = useState(false);
  const versions = useInfiniteQuery({
    queryKey: ["studio", "artifact-versions", artifact.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listArtifactVersions(artifact.id, { limit: 30, cursor: pageParam }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const versionItems = [
    ...new Map(
      versions.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.artifactVersionId, item]),
    ).values(),
  ];
  const versionId =
    selected || artifact.currentVersion?.artifactVersionId || "";
  useEffect(() => {
    if (!versionId) return;
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("artifact");
    if (
      (requested && requested !== artifact.id) ||
      url.searchParams.has("artifactVersion")
    )
      return;
    url.searchParams.set("artifact", artifact.id);
    url.searchParams.set("artifactVersion", versionId);
    window.history.replaceState(null, "", url);
  }, [artifact.id, versionId]);
  const detail = useQuery({
    queryKey: workbenchQueryKeys.artifactVersion(
      artifact.projectId,
      artifact.id,
      versionId,
    ),
    queryFn: () => api.getArtifactVersion(artifact.id, versionId),
    enabled: Boolean(versionId),
  });
  const recordKey = studioRecordKey(
    user?.id,
    artifact.projectId,
    "document-edit",
    artifact.id,
    versionId,
  );
  const currentKey = useRef(recordKey);
  currentKey.current = recordKey;
  const local = useStudioStoredRecord(recordKey, documentDraftRecordSchema);
  const [conflictReview, setConflictReview] = useState<{
    key: string | null;
    baseline: NonNullable<z.infer<typeof documentDraftRecordSchema>["baseline"]>;
  } | null>(null);
  const value = detail.error ? undefined : detail.data?.value,
    content = detail.error
      ? null
      : (draft ??
        (value?.contentMode === "inline"
          ? (value.content as unknown as JsonValue)
          : null));
  const update = (path: (string | number)[], text: JsonValue) => {
    if (content === null) return;
    const copy = structuredClone(content);
    let parent = copy as Record<string, unknown>;
    for (const part of path.slice(0, -1))
      parent = parent[part] as Record<string, unknown>;
    parent[path.at(-1)!] = text;
    if (value?.kind === "prd") {
      const document = copy as unknown as PrdDocument;
      if (
        path.join(".") === "cover.workOrderName" &&
        typeof text === "string"
      ) {
        document.title = `${text}需求说明书`;
        document.cover.title = document.title;
      }
      if (
        path.slice(0, 3).join(".") ===
          "sections.businessRequirements.functionSections" &&
        path.at(-1) === "title"
      ) {
        document.tableOfContents.entries = prdTableOfContentsEntriesForV3(
          document.sections.businessRequirements.functionSections.map(
            (section) => section.title,
          ),
        );
      }
    }
    setDraft(copy);
    if (value?.kind === "prd")
      local.save({
        ...local.value,
        version: 1,
        baseChecksum: value.checksum,
        draft: copy,
        prepared: null,
      });
  };
  const render = (
    data: JsonValue,
    path: (string | number)[] = [],
    depth = 0,
  ): ReactNode => {
    if (data === null) return null;
    if (typeof data === "string")
      return editing &&
        editable.has(String(path.at(-1))) &&
        !fixedPrdTitles.has(path.join(".")) ? (
        <textarea
          key={path.join(".")}
          aria-label={`编辑 ${path.join(" / ")}`}
          value={data}
          disabled={!canEdit || action.busy}
          onChange={(e) => update(path, e.target.value)}
        />
      ) : (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{data}</ReactMarkdown>
      );
    if (typeof data === "boolean")
      return (
        <label>
          <input
            type="checkbox"
            aria-label={`编辑 ${path.join(" / ")}`}
            checked={data}
            disabled={!canEdit || action.busy}
            onChange={(event) => update(path, event.target.checked)}
          />
          {path.at(-1) === "applicable" ? "适用业务降级方案" : "是否启用"}
        </label>
      );
    if (typeof data === "number") return <span>{data}</span>;
    if (Array.isArray(data) && path.join(".") === "versionHistory")
      return (
        <PrdVersionHistory
          entries={data as unknown as PrdDocument["versionHistory"]}
          disabled={!canEdit || action.busy}
          onChange={(next) => update(path, next)}
        />
      );
    if (Array.isArray(data))
      return (
        <div className="studio-document-blocks">
          {data.map((item, i) => (
            <div key={i}>{render(item, [...path, i], depth + 1)}</div>
          ))}
        </div>
      );
    if (
      path.join(".") === "cover" &&
      typeof data.workOrderName === "string" &&
      typeof data.title === "string"
    )
      return (
        <PrdCover
          cover={{ workOrderName: data.workOrderName, title: data.title }}
          disabled={!canEdit || action.busy}
          onChange={(name) => update([...path, "workOrderName"], name)}
        />
      );
    if (data.title === "活动投放渠道") {
      const rows = prdChannelRowSchema.array().safeParse(data.rows);
      if (rows.success)
        return (
          <PrdChannels
            table={{ title: "活动投放渠道", rows: rows.data }}
            disabled={!canEdit || action.busy}
            onChange={(next) => update(path, next)}
          />
        );
    }
    if (
      data.title === "4 需求安全基线要求（必填）" &&
      typeof data.intro === "string"
    ) {
      const rows = prdSafetyBaselineRowSchema.array().safeParse(data.rows);
      if (rows.success)
        return (
          <PrdSafetyBaseline
            baseline={{
              title: "4 需求安全基线要求（必填）",
              intro: data.intro,
              rows: rows.data,
            }}
            disabled={!canEdit || action.busy}
            onChange={(next) => update(path, next)}
          />
        );
    }
    if (data.kind === "productFlow" || data.kind === "productArchitecture") {
      const diagram = prdTemplateDiagramSchema.safeParse(data);
      if (diagram.success) return <PrdDiagram diagram={diagram.data} />;
    }
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
          disabled={action.busy}
          onChange={(e) => {
            const url = new URL(window.location.href);
            url.searchParams.set("artifact", artifact.id);
            url.searchParams.set("artifactVersion", e.target.value);
            window.history.pushState(null, "", url);
            setSelected(e.target.value);
            setDraft(null);
            setEditing(false);
          }}
        >
          {versionId &&
            !versionItems.some(
              (item) => item.artifactVersionId === versionId,
            ) && (
              <option value={versionId}>固定版本 {value?.version ?? ""}</option>
            )}
          {versionItems.map((v) => (
            <option value={v.artifactVersionId} key={v.artifactVersionId}>
              版本 {v.version} · {v.status}
            </option>
          ))}
        </select>
        <span>已载入 {versionItems.length} 个版本</span>
        {versions.hasNextPage && (
          <button
            disabled={versions.isFetchingNextPage}
            onClick={() => void versions.fetchNextPage()}
          >
            加载更多版本
          </button>
        )}
        {versions.error && (
          <p role="alert">
            版本列表加载失败。
            <button onClick={() => void versions.refetch()}>
              重试版本列表
            </button>
          </p>
        )}
        {value?.kind === "prd" && value.contentMode === "inline" && (
          <>
            <button
              disabled={!canEdit || action.busy}
              onClick={() => {
                if (editing) {
                  setEditing(false);
                  setDraft(null);
                  return;
                }
                const restored =
                  local.value?.baseChecksum === value.checksum
                    ? local.value.draft
                    : (value.content as unknown as JsonValue);
                setDraft(restored);
                local.save(
                  local.value?.baseChecksum === value.checksum
                    ? local.value
                    : {
                        version: 1,
                        baseChecksum: value.checksum,
                        draft: restored,
                        prepared: null,
                      },
                );
                setEditing(true);
              }}
            >
              {editing
                ? "退出编辑并保留草稿"
                : local.value
                  ? "恢复文档编辑"
                  : "编辑文档"}
            </button>
            {local.value && (
              <button
                disabled={!canEdit || action.busy}
                onClick={() => {
                  local.clear();
                  setDraft(null);
                  setEditing(false);
                }}
              >
                放弃文档草稿
              </button>
            )}
            {editing && local.value?.conflict && (
              <section aria-label="文档保存冲突">
                <p role="alert">文档已有更新，草稿已保留。请先核对最新版本，再选择是否用当前草稿创建新版本。</p>
                <button disabled={!canEdit || action.busy} onClick={() => void action.run(async () => {
                  const operationKey = recordKey;
                  const current = await api.getArtifact(artifact.id);
                  const id = current.value.currentVersion?.artifactVersionId;
                  if (current.value.projectId !== artifact.projectId || !id) throw new Error("最新文档不可用，请重新读取");
                  const latest = await api.getArtifactVersion(artifact.id, id);
                  if (!alive.current || !local.isCurrent() || currentKey.current !== operationKey) return;
                  if (latest.value.artifactId !== artifact.id || latest.value.kind !== "prd" || latest.value.status !== "ready" || latest.value.contentMode !== "inline") throw new Error("最新版本暂不能编辑，请稍后重试");
                  setConflictReview({ key: operationKey, baseline: { artifactVersionId: id, etag: current.etag, document: prdDocumentSchema.parse(latest.value.content) } });
                }, "最新版本已读取，请核对正文")}>读取最新版本并核对</button>
                {conflictReview?.key === recordKey && (
                  <>
                    <details open><summary>最新版本正文</summary><StructuredContent value={conflictReview.baseline.document as unknown as JsonValue} /></details>
                    <p>下方仍是你的草稿。继续后，保存将以这份草稿创建新版本；最新正文不会自动合并。文档身份和引用沿用已核对的版本。</p>
                    <button disabled={!canEdit || action.busy} onClick={() => {
                      if (!content || !local.value) return;
                      const { conflict: _conflict, ...record } = local.value;
                      if (local.save({ ...record, draft: content, prepared: null, baseline: conflictReview.baseline })) setConflictReview(null);
                    }}>已核对，以最新版本为基线</button>
                  </>
                )}
              </section>
            )}
            {editing && (
              <button
                disabled={!canEdit || action.busy || !!local.value?.conflict || !local.ready}
                onClick={() =>
                  void action.run(async () => {
                    const operationKey = recordKey;
                    const signature = canonicalJson(content);
                    let prepared =
                      local.value?.prepared?.signature === signature
                        ? local.value.prepared
                        : null;
                    if (!prepared) {
                      const document = parsePrdDraft(content);
                      const baseline = local.value?.baseline?.document ?? prdDocumentSchema.parse(value.content);
                      const current = local.value?.baseline
                        ? { value: { projectId: artifact.projectId, currentVersion: { artifactVersionId: local.value.baseline.artifactVersionId } }, etag: local.value.baseline.etag }
                        : await api.getArtifact(artifact.id);
                      if (
                        !alive.current ||
                        !local.isCurrent() ||
                        currentKey.current !== operationKey
                      )
                        return;
                      if (current.value.projectId !== artifact.projectId)
                        throw new Error("文档不属于当前项目");
                      if (!local.value?.baseline && current.value.currentVersion?.artifactVersionId !== versionId) {
                        local.save({ version: 1, baseChecksum: value.checksum, draft: content!, prepared: null, conflict: true });
                        throw new Error("文档已有更新，请读取最新版本并核对。草稿已保留。");
                      }
                      prepared = {
                        signature,
                        key: `studio-prd:${crypto.randomUUID()}`,
                        etag: current.etag,
                        document: prdDocumentSchema.parse({
                          ...document,
                          documentId: baseline.documentId,
                          citations: baseline.citations,
                          revision: {
                            ...document.revision,
                            number:
                              Math.max(
                                document.revision.number,
                                baseline.revision.number,
                              ) + 1,
                            status: "draft",
                            changedAt: new Date().toISOString(),
                            changedById: null,
                            summary: "手动编辑需求文档",
                          },
                        }),
                      };
                      if (!local.save({
                        ...local.value,
                        version: 1,
                        baseChecksum: value.checksum,
                        draft: content!,
                        prepared,
                      })) throw new Error("保存动作未能记录，文档尚未提交。请保留页面并重试。");
                    }
                    if (
                      !alive.current ||
                      !local.isCurrent() ||
                      currentKey.current !== operationKey
                    )
                      return;
                    let next;
                    try { next = await api.createArtifactVersion(
                      artifact.id,
                      {
                        kind: "prd",
                        baseArtifactVersionId: local.value?.baseline?.artifactVersionId ?? versionId,
                        document: prepared.document,
                      },
                      prepared.etag,
                      prepared.key,
                    ); } catch (cause) {
                      if (isWorkbenchApiError(cause) && [409, 412].includes(cause.status) && alive.current && local.isCurrent() && currentKey.current === operationKey) {
                        local.save({ version: 1, baseChecksum: value.checksum, draft: content!, prepared: null, conflict: true });
                        setConflictReview(null);
                      }
                      throw cause;
                    }
                    if (
                      !alive.current ||
                      !local.isCurrent() ||
                      currentKey.current !== operationKey
                    )
                      return;
                    local.clear();
                    const url = new URL(window.location.href);
                    url.searchParams.set("artifact", artifact.id);
                    url.searchParams.set(
                      "artifactVersion",
                      next.value.artifactVersionId,
                    );
                    window.history.replaceState(null, "", url);
                    setSelected(next.value.artifactVersionId);
                    setDraft(null);
                    setEditing(false);
                    await versions.refetch();
                    await client.invalidateQueries({
                      queryKey: workbenchQueryKeys.bootstraps(
                        artifact.projectId,
                      ),
                    });
                    await client.invalidateQueries({
                      queryKey: workbenchQueryKeys.artifacts(
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
      {local.error && <p role="alert">{local.error}</p>}
      {!editing && local.value && value?.kind === "prd" && (
        <p role="status">
          此版本有本地文档草稿，可恢复编辑。已保存版本尚未改变。
        </p>
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
      {value?.contentMode === "blob" && !detail.error && (
        <VerifiedBlobContent
          cacheKey={[artifact.projectId, artifact.id, versionId]}
          metadata={value.blob}
          load={() => api.getArtifactVersionContent(artifact.id, versionId)}
          title={artifact.title}
          actions={
            canEdit && value.kind === "image"
              ? (blob) =>
                  editingImage ? (
                    <ImageEditor
                      key={versionId}
                      projectId={artifact.projectId}
                      source={{
                        artifact,
                        versionId,
                        blob,
                        fileName:
                          value.blob.fileName ?? `${artifact.title}.png`,
                      }}
                      onClose={() => setEditingImage(false)}
                    />
                  ) : (
                    <button onClick={() => setEditingImage(true)}>
                      编辑图片
                    </button>
                  )
              : undefined
          }
        />
      )}
      {value?.kind === "prototype" &&
      value.contentMode === "inline" &&
      !detail.error ? (
        <PrototypeArtifactPreview
          cacheKey={[artifact.projectId, artifact.id, versionId]}
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
      {canEdit &&
        value?.status === "ready" &&
        value.kind === "prototype" &&
        value.contentMode === "inline" &&
        value.schemaVersion === 1 && (
          <PrototypeVariants
            key={value.artifactVersionId}
            source={{
              artifactId: value.artifactId,
              artifactVersionId: value.artifactVersionId,
            }}
            versionTitle={`${artifact.title} · 版本 ${value.version}`}
            screens={value.content.screens.map((screen) => ({
              id: screen.id,
              title: screen.name,
            }))}
            onPrompt={onPrompt}
          />
        )}
      {value?.status === "ready" && !detail.error && (
        <ArtifactLinks
          key={versionId}
          artifact={artifact}
          versionId={versionId}
          canEdit={canEdit}
        />
      )}
    </>
  );
}

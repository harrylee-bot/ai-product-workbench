"use client";
import { useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  artifactLinkKindSchema,
  createArtifactLinkRequestSchema,
  type Artifact,
  type ArtifactLink,
} from "@workbench/workbench-contracts";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { useWorkbenchArtifactsApi } from "@/lib/studio/api";
import {
  studioRecordKey,
  useStudioStoredRecord,
} from "@/lib/studio/stored-record";
import { documentUrl } from "./relations";

const labels = {
  related: "相关产物",
  reference: "参考引用",
  derived: "派生产物",
  variant: "设计变体",
};
const commandSchema = z
  .object({
    version: z.literal(1),
    description: z.string(),
    operation: z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("create"),
          key: z.string().min(8),
          request: createArtifactLinkRequestSchema,
        })
        .strict(),
      z
        .object({
          action: z.literal("remove"),
          id: z.string().min(1),
          etag: z.string().min(3),
        })
        .strict(),
    ]),
  })
  .strict();
type Command = z.infer<typeof commandSchema>;
function Endpoint({
  projectId,
  value,
}: {
  projectId: string;
  value: ArtifactLink["source"];
}) {
  return (
    <a href={documentUrl(projectId, value.artifactId, value.artifactVersionId)}>
      {value.title} · 版本 {value.version}
    </a>
  );
}

export function ArtifactLinks({
  artifact,
  versionId,
  canEdit,
}: {
  artifact: Artifact;
  versionId: string;
  canEdit: boolean;
}) {
  const api = useWorkbenchArtifactsApi(),
    client = useQueryClient(),
    { user } = useWorkbenchAuth();
  const local = useStudioStoredRecord(
    studioRecordKey(
      user?.id,
      artifact.projectId,
      "artifact-link",
      artifact.id,
      versionId,
    ),
    commandSchema,
  );
  const [includeRemoved, setIncludeRemoved] = useState(false),
    [creating, setCreating] = useState(false);
  const [otherArtifactId, setOtherArtifactId] = useState(""),
    [otherVersionId, setOtherVersionId] = useState("");
  const [direction, setDirection] = useState("outgoing"),
    [kind, setKind] =
      useState<z.infer<typeof artifactLinkKindSchema>>("related"),
    [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const working = useRef(false);
  const links = useInfiniteQuery({
    queryKey: [
      "studio",
      "artifact-links",
      artifact.projectId,
      versionId,
      includeRemoved,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listArtifactLinks(artifact.projectId, {
        artifactVersionId: versionId,
        includeRemoved,
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const artifacts = useInfiniteQuery({
    queryKey: ["studio", "link-artifacts", artifact.projectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listArtifacts(artifact.projectId, { cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: creating && canEdit,
  });
  const versions = useInfiniteQuery({
    queryKey: ["studio", "artifact-versions", otherArtifactId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listArtifactVersions(otherArtifactId, {
        cursor: pageParam,
        limit: 30,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: creating && canEdit && !!otherArtifactId,
  });
  const items = [
    ...new Map(
      links.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const candidates = [
    ...new Map(
      artifacts.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const versionItems = [
    ...new Map(
      versions.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.artifactVersionId, item]),
    ).values(),
  ].filter(
    (item) => item.status === "ready" && item.artifactVersionId !== versionId,
  );
  const perform = async (command: Command) => {
    if (working.current || !canEdit || !local.isCurrent()) return;
    if (
      command.operation.action === "create" &&
      ![
        command.operation.request.source,
        command.operation.request.target,
      ].some(
        (endpoint) =>
          endpoint.artifactId === artifact.id &&
          endpoint.artifactVersionId === versionId,
      )
    ) {
      setError("关联记录与当前版本不匹配，请重新打开原版本。");
      return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    local.save(command);
    try {
      const op = command.operation;
      const result =
        op.action === "create"
          ? await api.createArtifactLink(artifact.projectId, op.request, op.key)
          : await api.removeArtifactLink(artifact.projectId, op.id, op.etag);
      if (!local.isCurrent()) return;
      local.clear();
      setCreating(false);
      setOtherArtifactId("");
      setOtherVersionId("");
      setLabel("");
      setNotice(
        result.value.removedAt
          ? "此关联已移除，两个产物及其版本仍然保留。"
          : "关联已保存，来源和目标均固定到所选版本。",
      );
      void client.invalidateQueries({
        queryKey: ["studio", "artifact-links", artifact.projectId],
      });
    } catch (cause) {
      if (local.isCurrent())
        setError(
          cause instanceof Error ? cause.message : "关联操作未确认，请重试。",
        );
    } finally {
      working.current = false;
      if (local.isCurrent()) setBusy(false);
    }
  };
  return (
    <section
      className="studio-relations studio-artifact-links"
      aria-label="固定版本产物关联"
    >
      <h2>产物关联</h2>
      <p className="visual-muted">
        关联保留所选版本。更新产物不会改动已有的来源与目标。
      </p>
      <label>
        <input
          type="checkbox"
          checked={includeRemoved}
          onChange={(event) => setIncludeRemoved(event.target.checked)}
        />{" "}
        显示已移除关联
      </label>
      {links.isPending && <p role="status">正在读取产物关联…</p>}
      {links.error && (
        <p role="alert">
          产物关联暂不可用。
          <button
            onClick={() =>
              void (links.isFetchNextPageError
                ? links.fetchNextPage()
                : links.refetch())
            }
          >
            重试产物关联
          </button>
        </p>
      )}
      {!links.isPending && !links.error && items.length === 0 && (
        <p>此版本尚无{includeRemoved ? "" : "有效"}产物关联。</p>
      )}
      <ul className="studio-link-list">
        {items.map((link) => (
          <li key={link.id}>
            <div>
              <Endpoint projectId={artifact.projectId} value={link.source} />
              <span aria-label="指向"> → </span>
              <Endpoint projectId={artifact.projectId} value={link.target} />
            </div>
            <p>
              {Object.hasOwn(labels, link.kind)
                ? labels[link.kind as keyof typeof labels]
                : "历史关联"}
              {link.label ? ` · ${link.label}` : ""}
              {link.origin === "imported" ? " · 已迁移的固定版本关联" : ""}
              {link.removedAt ? " · 已移除" : ""}
            </p>
            {canEdit && !link.removedAt && (
              <button
                disabled={busy || !!local.value}
                onClick={() =>
                  void perform({
                    version: 1,
                    description: `${link.source.title} → ${link.target.title}：移除关联`,
                    operation: {
                      action: "remove",
                      id: link.id,
                      etag: `"${link.revision}"`,
                    },
                  })
                }
              >
                移除关联
              </button>
            )}
          </li>
        ))}
      </ul>
      {links.hasNextPage && (
        <button
          disabled={links.isFetchingNextPage}
          onClick={() => void links.fetchNextPage()}
        >
          加载更多产物关联
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {local.error && <p role="alert">{local.error}</p>}
      {local.value && (
        <div className="studio-link-pending">
          <p>待确认操作：{local.value.description}</p>
          <p>服务器可能已完成操作，继续确认会使用原请求。</p>
          <button
            disabled={busy || !canEdit}
            onClick={() => void perform(local.value!)}
          >
            确认上次关联操作
          </button>
          <button
            disabled={busy}
            onClick={() => {
              local.clear();
              setError("");
              setNotice(
                "已清除本地记录。服务器中已保存的关联仍保留，请先核对列表。",
              );
              void links.refetch();
            }}
          >
            清除本地操作记录
          </button>
        </div>
      )}
      {canEdit && !local.value && !creating && (
        <button
          onClick={() => {
            setCreating(true);
            setNotice("");
          }}
        >
          添加产物关联
        </button>
      )}
      {canEdit && !local.value && creating && (
        <form
          className="studio-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            const other = candidates.find(
                (item) => item.id === otherArtifactId,
              ),
              selected = versionItems.find(
                (item) => item.artifactVersionId === otherVersionId,
              );
            if (!other || !selected) {
              setError("请选择一个产物及其可用的固定版本。");
              return;
            }
            const current = {
                artifactId: artifact.id,
                artifactVersionId: versionId,
              },
              target = {
                artifactId: other.id,
                artifactVersionId: selected.artifactVersionId,
              };
            void perform({
              version: 1,
              description: `${direction === "outgoing" ? `${artifact.title} → ${other.title}` : `${other.title} → ${artifact.title}`} · ${labels[kind]}`,
              operation: {
                action: "create",
                key: `artifact-link:${crypto.randomUUID()}`,
                request: {
                  source: direction === "outgoing" ? current : target,
                  target: direction === "outgoing" ? target : current,
                  kind,
                  label: label.trim() || null,
                },
              },
            });
          }}
        >
          <label>
            关联方向
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            >
              <option value="outgoing">当前版本作为来源 → 所选版本</option>
              <option value="incoming">所选版本作为来源 → 当前版本</option>
            </select>
          </label>
          <label>
            关联产物
            <select
              aria-label="关联产物"
              value={otherArtifactId}
              onChange={(event) => {
                setOtherArtifactId(event.target.value);
                setOtherVersionId("");
              }}
            >
              <option value="">请选择产物</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {artifacts.isPending && <p role="status">正在读取可选产物…</p>}
          {artifacts.error && (
            <p role="alert">
              可选产物读取失败。
              <button type="button" onClick={() => void artifacts.refetch()}>
                重试可选产物
              </button>
            </p>
          )}
          {artifacts.hasNextPage && (
            <button
              type="button"
              disabled={artifacts.isFetchingNextPage}
              onClick={() => void artifacts.fetchNextPage()}
            >
              加载更多可选产物
            </button>
          )}
          <label>
            关联固定版本
            <select
              aria-label="关联固定版本"
              required
              disabled={!otherArtifactId}
              value={otherVersionId}
              onChange={(event) => setOtherVersionId(event.target.value)}
            >
              <option value="">请选择可用版本</option>
              {versionItems.map((item) => (
                <option
                  key={item.artifactVersionId}
                  value={item.artifactVersionId}
                >
                  版本 {item.version}
                </option>
              ))}
            </select>
          </label>
          {otherArtifactId && versions.isPending && (
            <p role="status">正在读取可用版本…</p>
          )}
          {otherArtifactId && versions.error && (
            <p role="alert">
              版本读取失败。
              <button type="button" onClick={() => void versions.refetch()}>
                重试关联版本
              </button>
            </p>
          )}
          {otherArtifactId && versions.hasNextPage && (
            <button
              type="button"
              disabled={versions.isFetchingNextPage}
              onClick={() => void versions.fetchNextPage()}
            >
              加载更多可选版本
            </button>
          )}
          <label>
            关联类型
            <select
              value={kind}
              onChange={(event) =>
                setKind(artifactLinkKindSchema.parse(event.target.value))
              }
            >
              {Object.entries(labels).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            关联说明（选填）
            <input
              maxLength={240}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <div>
            <button disabled={busy || !otherVersionId} type="submit">
              保存产物关联
            </button>
            <button
              disabled={busy}
              type="button"
              onClick={() => setCreating(false)}
            >
              取消添加
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

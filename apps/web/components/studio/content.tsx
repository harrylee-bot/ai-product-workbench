"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  JsonValue,
  ExportPreviewTokenResponse,
} from "@workbench/workbench-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { saveBlob, verifyDownload } from "./actions";

const hidden = new Set([
  "protocol",
  "schemaVersion",
  "id",
  "documentId",
  "revision",
  "source",
  "createdAt",
  "updatedAt",
  "changedAt",
  "checksum",
  "kind",
  "type",
  "nodeId",
  "pageId",
  "artifactId",
  "artifactVersionId",
  "sourceRefs",
  "metadata",
  "build",
  "files",
]);
/** Domain documents use their typed block structure; generated HTML never enters this renderer. */
export function StructuredContent({ value }: { value: JsonValue }): ReactNode {
  if (value === null) return null;
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  if (typeof value === "number") return <span>{value}</span>;
  if (typeof value === "string")
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>;
  if (Array.isArray(value))
    return (
      <>
        {value.map((item, index) => (
          <StructuredContent key={index} value={item} />
        ))}
      </>
    );
  const render = (v: JsonValue | undefined) =>
    v === undefined ? null : <StructuredContent value={v} />;
  const list = Array.isArray(value.items) ? value.items : [];
  if (value.type === "text" && typeof value.text === "string") {
    let node: ReactNode = value.text;
    for (const mark of Array.isArray(value.marks) ? value.marks : []) {
      if (mark === "strong") node = <strong>{node}</strong>;
      if (mark === "emphasis") node = <em>{node}</em>;
      if (mark === "code") node = <code>{node}</code>;
      if (mark === "strikethrough") node = <del>{node}</del>;
    }
    return <>{node}</>;
  }
  if (value.type === "link" && typeof value.href === "string")
    return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(value.href) ? (
      <a href={value.href} rel="noreferrer">
        {String(value.text ?? value.href)}
      </a>
    ) : (
      <span>{String(value.text ?? "链接")}</span>
    );
  if (value.type === "reference")
    return (
      <a href={`#${value.targetId}`}>{String(value.label ?? value.targetId)}</a>
    );
  if (value.type === "citation")
    return <sup>{String(value.label ?? value.citationId)}</sup>;
  if (value.type === "paragraph")
    return <p id={String(value.id ?? "")}>{render(value.content)}</p>;
  if (value.type === "heading")
    return value.level === 3 ? (
      <h3>{render(value.content)}</h3>
    ) : (
      <h2>{render(value.content)}</h2>
    );
  if (value.type === "bulletList" || value.type === "orderedList") {
    const children = list.map((item, i) => (
      <li key={i}>
        {render(
          item && typeof item === "object" && !Array.isArray(item)
            ? item.content
            : item,
        )}
      </li>
    ));
    return value.type === "orderedList" ? (
      <ol>{children}</ol>
    ) : (
      <ul>{children}</ul>
    );
  }
  if (Array.isArray(value.rows)) {
    const rows = value.rows.filter(
      (row): row is Record<string, JsonValue> =>
        !!row && typeof row === "object" && !Array.isArray(row),
    );
    const columns = Array.isArray(value.columns)
      ? value.columns.filter(
          (c): c is Record<string, JsonValue> =>
            !!c && typeof c === "object" && !Array.isArray(c),
        )
      : null;
    const keys = columns?.map((c) => String(c.id)) ?? [
      ...new Set(
        rows.flatMap((row) => Object.keys(row).filter((k) => !hidden.has(k))),
      ),
    ];
    return (
      <section>
        {value.title && <h3>{String(value.title)}</h3>}
        <div className="studio-table-scroll">
          <table>
            <thead>
              <tr>
                {keys.map((key, i) => (
                  <th key={key}>
                    {String(columns?.[i]?.label ?? fieldLabel(key))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {keys.map((key) => (
                    <td key={key}>
                      {render(
                        columns && Array.isArray(row.cells)
                          ? (
                              row.cells.find(
                                (c) =>
                                  !!c &&
                                  typeof c === "object" &&
                                  !Array.isArray(c) &&
                                  c.columnId === key,
                              ) as Record<string, JsonValue> | undefined
                            )?.content
                          : row[key],
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }
  return (
    <section
      id={typeof value.id === "string" ? value.id : undefined}
      className="studio-document-section"
    >
      {Object.entries(value)
        .filter(([key]) => !hidden.has(key))
        .map(([key, item]) => (
          <div key={key}>
            {key === "title" ? (
              <h2>{String(item)}</h2>
            ) : (
              <>
                {[
                  "given",
                  "when",
                  "then",
                  "successMetric",
                  "priority",
                  "mitigation",
                  "painPoints",
                  "needs",
                ].includes(key) && <strong>{fieldLabel(key)}： </strong>}
                {render(item)}
              </>
            )}
          </div>
        ))}
    </section>
  );
}
function fieldLabel(key: string) {
  return (
    (
      {
        given: "前提",
        when: "操作",
        then: "预期结果",
        successMetric: "成功指标",
        priority: "优先级",
        mitigation: "应对方案",
        painPoints: "痛点",
        needs: "需求",
        sequence: "序号",
        requirement: "要求",
        scope: "适用范围",
        answer: "自查结果",
        evidence: "依据",
        channel: "渠道",
        selected: "是否启用",
        description: "说明",
        notes: "备注",
      } as Record<string, string>
    )[key] ?? key
  );
}

export function VerifiedBlobContent({
  cacheKey,
  metadata,
  load,
  title,
  actions,
}: {
  actions?: (blob: Blob) => ReactNode;
  cacheKey: readonly string[];
  metadata: { sha256: string; byteSize: number; fileName: string | null };
  load: () => Promise<Blob>;
  title: string;
}) {
  const query = useQuery({
    queryKey: [
      "studio",
      "verified-blob",
      ...cacheKey,
      metadata.sha256,
      metadata.byteSize,
    ],
    queryFn: async () =>
      verifyDownload(await load(), {
        sha256: metadata.sha256,
        size: metadata.byteSize,
      }),
    staleTime: Infinity,
    retry: false,
  });
  if (query.error)
    return (
      <p role="alert">
        文件未通过读取或完整性校验。
        <button onClick={() => void query.refetch()}>重新读取文件</button>
      </p>
    );
  if (!query.data) return <p role="status">正在读取并校验文件…</p>;
  return (
    <>
      {actions?.(query.data)}
      <BlobContent
        blob={query.data}
        title={title}
        fileName={metadata.fileName ?? title}
      />
    </>
  );
}

export function BlobContent({
  blob,
  title,
  fileName = title,
}: {
  blob: Blob;
  title: string;
  fileName?: string;
}) {
  const [resource, setResource] = useState<{
    blob: Blob;
    url: string;
    text: string;
  } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setResource({ blob, url, text: "" });
    let active = true;
    if (
      (blob.type.startsWith("text/") || /json|xml/.test(blob.type)) &&
      blob.size <= 2 * 1024 * 1024
    )
      void blob.text().then((value) => {
        if (active) setResource({ blob, url, text: value });
      });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  // A changed version never reuses the previous version's object URL or text.
  const url = resource?.blob === blob ? resource.url : "";
  const text = resource?.blob === blob ? resource.text : "";
  return (
    <>
      <button onClick={() => saveBlob(blob, fileName)}>下载原文件</button>
      {blob.type.startsWith("image/") && url ? (
        <img className="studio-media" src={url} alt={title} />
      ) : blob.type.startsWith("video/") && url ? (
        <video
          className="studio-media"
          src={url}
          controls
          preload="metadata"
          aria-label={title}
        />
      ) : blob.type.startsWith("audio/") && url ? (
        <audio src={url} controls preload="metadata" aria-label={title} />
      ) : blob.type === "application/pdf" && url ? (
        <iframe className="studio-document-frame" title={title} src={url} />
      ) : text ? (
        <pre className="studio-text-content">{text}</pre>
      ) : (
        <p>此文件可下载后查看。</p>
      )}
    </>
  );
}

export function PrototypeArtifactPreview({
  title,
  cacheKey,
  create,
}: {
  title: string;
  cacheKey: readonly string[];
  create: () => Promise<ExportPreviewTokenResponse>;
}) {
  const query = useQuery({
    queryKey: ["studio", "artifact-preview", ...cacheKey],
    queryFn: create,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = query.data;
  const [expiredUrl, setExpiredUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => setExpiredUrl(preview.url),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  const expired =
    !!preview &&
    (expiredUrl === preview.url || Date.parse(preview.expiresAt) <= Date.now());
  return (
    <div className="studio-source-preview">
      {query.isPending && <p role="status">正在准备交互预览…</p>}
      {query.error && <p role="alert">暂时无法加载此版本的交互预览。</p>}
      {expired && <p role="status">预览已过期，请重新打开。</p>}
      <button disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.error || expired ? "重新打开预览" : "重新加载预览"}
      </button>
      {!query.error && preview && !expired && (
        <iframe
          title={title}
          src={preview.url}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}

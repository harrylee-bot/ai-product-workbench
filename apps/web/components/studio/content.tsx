"use client";
import { useEffect, useState, type ReactNode } from "react";
import type {
  JsonValue,
  ExportPreviewTokenResponse,
} from "@workbench/workbench-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { saveBlob, useStudioAction } from "./actions";

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

export function BlobContent({ blob, title }: { blob: Blob; title: string }) {
  const [url, setUrl] = useState(""),
    [text, setText] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setUrl(url);
    let active = true;
    if (
      (blob.type.startsWith("text/") || /json|xml/.test(blob.type)) &&
      blob.size <= 2 * 1024 * 1024
    )
      void blob.text().then((value) => {
        if (active) setText(value);
      });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return (
    <>
      <button onClick={() => saveBlob(blob, title)}>下载原文件</button>
      {blob.type.startsWith("image/") && url ? (
        <img className="studio-media" src={url} alt={title} />
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

export function SourcePreview({
  title,
  create,
}: {
  title: string;
  create: () => Promise<ExportPreviewTokenResponse>;
}) {
  const action = useStudioAction(),
    [preview, setPreview] = useState<ExportPreviewTokenResponse | null>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        setPreview(null);
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  return (
    <div className="studio-source-preview">
      {action.notice}
      <button
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            setPreview(await create());
            setExpired(false);
          }, "预览已就绪")
        }
      >
        {preview
          ? "重新加载预览"
          : expired
            ? "预览已过期 · 重新打开"
            : "打开交互预览"}
      </button>
      {preview && (
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

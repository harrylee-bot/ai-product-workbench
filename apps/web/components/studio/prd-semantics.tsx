"use client";
import { useId, useMemo } from "react";
import { graphlib, layout } from "@dagrejs/dagre";
import {
  prdChannelLabels,
  prdSafetyBaselineItems,
  type PrdDocument,
  type PrdTemplateDiagram,
} from "@workbench/workbench-contracts";

export function PrdCover({
  cover,
  disabled,
  onChange,
}: {
  cover: PrdDocument["cover"];
  disabled?: boolean;
  onChange?: (name: string) => void;
}) {
  return (
    <section className="studio-document-section" aria-label="需求文档封面">
      <h2>{cover.title}</h2>
      {onChange ? (
        <label>
          工单名称
          <input
            aria-label="工单名称"
            value={cover.workOrderName}
            maxLength={200}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      ) : (
        <p>工单名称：{cover.workOrderName}</p>
      )}
    </section>
  );
}
export function PrdVersionHistory({
  entries,
  disabled,
  onChange,
}: {
  entries: PrdDocument["versionHistory"];
  disabled?: boolean;
  onChange?: (entries: PrdDocument["versionHistory"]) => void;
}) {
  const change = (
    index: number,
    patch: Partial<PrdDocument["versionHistory"][number]>,
  ) =>
    onChange?.(
      entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  return (
    <section className="studio-document-section" aria-label="版本修订记录">
      <h3>版本修订记录</h3>
      <div className="studio-table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "状态",
                "作者",
                "参与者",
                "起始日期",
                "结束日期",
                "修订说明",
              ].map((title) => (
                <th key={title} scope="col">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={index}>
                <td>
                  {onChange ? (
                    <select
                      aria-label={`版本${index + 1}状态`}
                      value={entry.status}
                      disabled={disabled}
                      onChange={(event) =>
                        change(index, {
                          status: event.target.value as typeof entry.status,
                        })
                      }
                    >
                      {["讨论稿", "评审中", "已定稿"].map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  ) : (
                    entry.status
                  )}
                </td>
                <td>
                  {onChange ? (
                    <input
                      aria-label={`版本${index + 1}作者`}
                      value={entry.author}
                      disabled={disabled}
                      maxLength={120}
                      onChange={(event) =>
                        change(index, { author: event.target.value })
                      }
                    />
                  ) : (
                    entry.author
                  )}
                </td>
                <td>
                  {onChange ? (
                    <input
                      aria-label={`版本${index + 1}参与者`}
                      value={entry.participants.join("、")}
                      disabled={disabled}
                      onChange={(event) =>
                        change(index, {
                          participants: event.target.value.split(/[、,，]/u),
                        })
                      }
                    />
                  ) : (
                    entry.participants.join("、")
                  )}
                </td>
                <td>
                  {onChange ? (
                    <input
                      aria-label={`版本${index + 1}起始日期`}
                      type="date"
                      value={entry.startDate}
                      disabled={disabled}
                      onChange={(event) =>
                        change(index, { startDate: event.target.value })
                      }
                    />
                  ) : (
                    entry.startDate
                  )}
                </td>
                <td>
                  {onChange ? (
                    <input
                      aria-label={`版本${index + 1}结束日期`}
                      type="date"
                      value={entry.endDate}
                      disabled={disabled}
                      onChange={(event) =>
                        change(index, { endDate: event.target.value })
                      }
                    />
                  ) : (
                    entry.endDate
                  )}
                </td>
                <td>
                  {onChange ? (
                    <textarea
                      aria-label={`版本${index + 1}备注`}
                      value={entry.notes}
                      disabled={disabled}
                      maxLength={1000}
                      onChange={(event) =>
                        change(index, { notes: event.target.value })
                      }
                    />
                  ) : (
                    entry.notes
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
type ChannelTable =
  PrdDocument["sections"]["introduction"]["usageScenarios"]["channelTable"];
type Baseline = PrdDocument["sections"]["safetyBaseline"];
export function PrdChannels({
  table,
  disabled,
  onChange,
}: {
  table: ChannelTable;
  disabled?: boolean;
  onChange?: (next: ChannelTable) => void;
}) {
  return (
    <section className="studio-document-section" aria-label={table.title}>
      <h3>{table.title}</h3>
      {onChange && <p>投放渠道须与使用场景正文一致，请同时更新相关描述。</p>}
      <div className="studio-table-scroll">
        <table>
          <caption className="studio-sr-only">活动投放渠道及启用状态</caption>
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">渠道</th>
              <th scope="col">是否投放</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={row.channel}>
                <td>{row.sequence}</td>
                <th scope="row">{prdChannelLabels[row.channel]}</th>
                <td>
                  {onChange ? (
                    <input
                      type="checkbox"
                      aria-label={`${prdChannelLabels[row.channel]}是否投放`}
                      checked={row.enabled}
                      disabled={disabled}
                      onChange={(event) =>
                        onChange({
                          ...table,
                          rows: table.rows.map((item, i) =>
                            i === index
                              ? { ...item, enabled: event.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                  ) : row.enabled ? (
                    "是"
                  ) : (
                    "否"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
export function PrdSafetyBaseline({
  baseline,
  disabled,
  onChange,
}: {
  baseline: Baseline;
  disabled?: boolean;
  onChange?: (next: Baseline) => void;
}) {
  return (
    <section className="studio-document-section" aria-label={baseline.title}>
      <h2>{baseline.title}</h2>
      <div className="studio-prd-intro">
        {baseline.intro.split("\n").map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
      {onChange && (
        <p>
          选择“是”或“否”时填写对应依据或整改方案，并与正文保持一致；“不涉及”不填写备注。
        </p>
      )}
      <div
        className="studio-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="需求安全基线表"
      >
        <table className="studio-prd-baseline">
          <thead>
            <tr>
              <th scope="col">序号</th>
              <th scope="col">安全基线要求</th>
              <th scope="col">适用范围</th>
              <th scope="col">判定</th>
              <th scope="col">备注 / 依据</th>
            </tr>
          </thead>
          <tbody>
            {baseline.rows.map((row, index) => {
              const item = prdSafetyBaselineItems.find(
                (item) => item.sequence === row.sequence,
              );
              return (
                <tr key={row.sequence}>
                  <th scope="row">{row.sequence}</th>
                  <td>{item?.requirement ?? "未识别的安全基线项"}</td>
                  <td>{item?.scope ?? "—"}</td>
                  <td>
                    {onChange ? (
                      <select
                        aria-label={`${row.sequence}安全基线判定`}
                        disabled={disabled}
                        value={row.applicability}
                        onChange={(event) =>
                          onChange({
                            ...baseline,
                            rows: baseline.rows.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    applicability: event.target
                                      .value as typeof item.applicability,
                                    remarks:
                                      event.target.value === "不涉及"
                                        ? null
                                        : item.remarks,
                                  }
                                : item,
                            ),
                          })
                        }
                      >
                        <option value="是">是</option>
                        <option value="否">否</option>
                        <option value="不涉及">不涉及</option>
                      </select>
                    ) : (
                      row.applicability
                    )}
                  </td>
                  <td>
                    {onChange ? (
                      <textarea
                        aria-label={`${row.sequence}安全基线备注`}
                        disabled={disabled || row.applicability === "不涉及"}
                        value={row.remarks ?? ""}
                        maxLength={1000}
                        onChange={(event) =>
                          onChange({
                            ...baseline,
                            rows: baseline.rows.map((item, i) =>
                              i === index
                                ? {
                                    ...item,
                                    remarks: event.target.value || null,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    ) : (
                      (row.remarks ?? "—")
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function wrapLabel(text: string, width = 14): string[] {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const chars = Array.from(line);
    for (let index = 0; index < chars.length; index += width)
      lines.push(chars.slice(index, index + width).join(""));
    if (!chars.length) lines.push("");
  }
  return lines.length ? lines : ["未命名"];
}
export function layoutPrdDiagram(diagram: PrdTemplateDiagram) {
  const graph = new graphlib.Graph({ directed: true, multigraph: true });
  graph.setGraph({
    rankdir: "TB",
    nodesep: 44,
    edgesep: 24,
    ranksep: 64,
    marginx: 28,
    marginy: 28,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of diagram.nodes) {
    const lines = wrapLabel(node.label || "未命名节点"),
      groupLines = node.group ? wrapLabel(node.group) : [];
    graph.setNode(node.id, {
      width: 224,
      height: Math.max(68, lines.length * 22 + groupLines.length * 18 + 28),
      lines,
      groupLines,
    });
  }
  for (const edge of diagram.edges) {
    const lines = edge.label ? wrapLabel(edge.label, 12) : [];
    graph.setEdge(
      edge.from,
      edge.to,
      {
        width: lines.length
          ? Math.min(
              170,
              Math.max(...lines.map((line) => Array.from(line).length)) * 13 +
                12,
            )
          : 0,
        height: lines.length * 18 + 8,
        labelpos: "c",
        lines,
      },
      edge.id,
    );
  }
  layout(graph);
  return {
    width: graph.graph().width!,
    height: graph.graph().height!,
    nodes: diagram.nodes.map((node) => ({ ...node, ...graph.node(node.id) })),
    edges: diagram.edges.map((edge) => ({
      ...edge,
      ...graph.edge({ v: edge.from, w: edge.to, name: edge.id }),
    })),
  };
}
export function PrdDiagram({ diagram }: { diagram: PrdTemplateDiagram }) {
  const id = useId().replaceAll(":", ""),
    graph = useMemo(() => layoutPrdDiagram(diagram), [diagram]);
  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
  return (
    <figure className="studio-prd-diagram" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`}>{diagram.title}</figcaption>
      <p id={`${id}-description`}>{diagram.description}</p>
      <p className="studio-muted">图示可滚动查看，也可展开下方的文字关系。</p>
      <div
        className="studio-prd-diagram-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${diagram.title}，可横向滚动查看`}
      >
        <svg
          role="img"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          style={{ width: graph.width, marginInline: "auto" }}
        >
          <defs>
            <marker
              id={`${id}-arrow`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge) => (
            <g
              key={edge.id}
              className="studio-prd-edge"
              data-prd-edge={edge.id}
            >
              <path
                d={edge.points
                  .map(
                    (point: { x: number; y: number }, index: number) =>
                      `${index ? "L" : "M"}${point.x},${point.y}`,
                  )
                  .join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                markerEnd={`url(#${id}-arrow)`}
              />
              {edge.lines.length > 0 && (
                <g transform={`translate(${edge.x},${edge.y})`}>
                  <rect
                    x={-edge.width / 2}
                    y={-edge.height / 2}
                    width={edge.width}
                    height={edge.height}
                    rx="4"
                    fill="white"
                  />
                  <text textAnchor="middle">
                    {edge.lines.map((line: string, index: number) => (
                      <tspan
                        key={index}
                        x="0"
                        y={index * 18 - (edge.lines.length - 1) * 9 + 5}
                      >
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              )}
            </g>
          ))}
          {graph.nodes.map((node) => (
            <g
              key={node.id}
              className="studio-prd-node"
              data-prd-node={node.id}
              transform={`translate(${node.x - node.width / 2},${node.y - node.height / 2})`}
            >
              <rect width={node.width} height={node.height} rx="10" />
              <text textAnchor="middle" x={node.width / 2}>
                {node.lines.map((line: string, index: number) => (
                  <tspan key={index} x={node.width / 2} y={25 + index * 22}>
                    {line}
                  </tspan>
                ))}
                {node.groupLines.map((line: string, index: number) => (
                  <tspan
                    key={`group-${index}`}
                    className="studio-prd-node-group"
                    x={node.width / 2}
                    y={27 + node.lines.length * 22 + index * 18}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <details>
        <summary>查看{diagram.title}的文字关系</summary>
        <ul>
          {diagram.edges.map((edge) => (
            <li key={edge.id}>
              {labels.get(edge.from)} → {labels.get(edge.to)}
              {edge.label ? `：${edge.label}` : ""}
            </li>
          ))}
        </ul>
        <p>
          节点分组：
          {diagram.nodes
            .map(
              (node) => `${node.label}${node.group ? `（${node.group}）` : ""}`,
            )
            .join("；")}
        </p>
      </details>
    </figure>
  );
}

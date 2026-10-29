import {
  generationPreviewSchema,
  type GenerationPreview,
  type GenerationPreviewNode,
} from "@workbench/workbench-contracts";
import { parse } from "partial-json";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, limit = 2_000): string => typeof value === "string"
  ? value.replace(/wb(?:kg|ct)1\.[A-Za-z0-9_.-]*/gu, "[已隐藏]").slice(0, limit) : "";
const numeric = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(-16_384, Math.min(16_384, value)) : fallback;
const literal = (value: unknown) => record(value).value ?? value;
const color = (value: unknown) => /^(?:#[a-fA-F0-9]{3,8}|transparent|white|black)$/.test(text(literal(value)))
  ? text(literal(value)) : null;

/** Samples tool argument streams before the first validated Artifact exists.
 * Raw token frames are consumed in memory, not written to the durable event inbox.
 */
export class RuntimeGenerationPreview {
  private calls = new Map<string, { name: string; args: string; sampledAt: number }>();
  private published = new Map<number, { at: number; value: string }>();

  constructor(private readonly kinds: readonly string[], private readonly now = Date.now) {}

  push(event: string, data: unknown): GenerationPreview[] {
    if (event !== "messages" && event !== "messages-tuple") return [];
    const raw = record(Array.isArray(data) ? data[0] : data);
    const message = Object.keys(record(raw.kwargs)).length ? record(raw.kwargs) : raw;
    const chunks = array(message.tool_call_chunks);
    const calls = chunks.length ? chunks : array(record(message.additional_kwargs).tool_calls ?? message.tool_calls);
    const previews: GenerationPreview[] = [];
    for (const [position, item] of calls.entries()) {
      const chunk = record(item);
      const fn = record(chunk.function);
      const key = `${text(message.id ?? raw.id, 240)}:${chunk.index ?? position}`;
      const previous = this.calls.get(key) ?? { name: "", args: "", sampledAt: -Infinity };
      const name = text(chunk.name ?? fn.name, 120) || previous.name;
      const args = chunk.args ?? fn.arguments;
      const value = typeof args === "string" ? previous.args + args : JSON.stringify(args ?? {});
      if (value.length > 2_000_000) { this.calls.delete(key); continue; }
      if (this.calls.size >= 32 && !this.calls.has(key)) this.calls.delete(this.calls.keys().next().value!);
      const state = { name, args: value, sampledAt: previous.sampledAt };
      this.calls.set(key, state);
      if (name !== "workbench_artifact_draft_publish" && name !== "workbench_runtime_result_submit") continue;
      if (this.now() - state.sampledAt < 750) continue;
      state.sampledAt = this.now();
      let parsed: RecordValue;
      try { parsed = record(parse(value)); } catch { continue; }
      const candidates = name === "workbench_artifact_draft_publish"
        ? [{ index: parsed.artifact_index, draft: parsed.draft }]
        : array(record(parsed.candidate).artifacts).map((draft, index) => ({ index, draft }));
      for (const candidate of candidates) {
        if (!Number.isInteger(candidate.index)) continue;
        const draft = record(candidate.draft);
        if (!this.kinds.includes(String(draft.kind))) continue;
        const preview = projectGenerationPreview(candidate.index as number, draft);
        if (!preview) continue;
        const signature = JSON.stringify(preview);
        const published = this.published.get(preview.artifactIndex);
        if (published && (signature === published.value || this.now() - published.at < 750)) continue;
        this.published.set(preview.artifactIndex, { at: this.now(), value: signature });
        previews.push(preview);
      }
    }
    return previews;
  }
}

export function projectGenerationPreview(artifactIndex: number, draft: RecordValue): GenerationPreview | null {
  if (draft.kind !== "prd" && draft.kind !== "prototype") return null;
  const content = record(draft.content);
  const title = text(draft.title ?? content.title, 240);
  if (!title) return null;
  const preview = {
    artifactIndex, kind: draft.kind, title,
    markdown: draft.kind === "prd" ? prdMarkdown(content).slice(0, 48_000) : "",
    screens: draft.kind === "prototype" ? array(content.screens).slice(0, 4).flatMap((value) => {
      const screen = record(value);
      const id = text(screen.id, 160);
      if (!id) return [];
      return [{
        id, name: text(screen.name, 240),
        width: Math.max(1, numeric(record(screen.viewport).width, 390)),
        height: Math.max(1, numeric(record(screen.viewport).height, 844)),
        nodes: array(content.nodes).filter((node) => record(node).screenId === id && record(node).visible !== false)
          .slice(0, 120).flatMap(projectNode),
      }];
    }) : [],
  };
  const parsed = generationPreviewSchema.safeParse(preview);
  return parsed.success ? parsed.data : null;
}

function projectNode(value: unknown): GenerationPreviewNode[] {
  const node = record(value);
  const layout = record(node.layout);
  const style = record(node.style);
  const typography = record(style.typography);
  const id = text(node.id, 160);
  const kind = node.kind;
  if (!id || !["frame", "form", "text", "button", "input", "image", "shape", "icon"].includes(String(kind))) return [];
  return [{
    id, parentId: text(node.parentId, 160) || null, kind: kind as GenerationPreviewNode["kind"],
    text: text(node.text ?? node.label ?? node.placeholder ?? node.name),
    x: numeric(literal(layout.x)), y: numeric(literal(layout.y)),
    width: layout.width == null ? null : Math.max(0, numeric(literal(layout.width))),
    height: layout.height == null ? null : Math.max(0, numeric(literal(layout.height))),
    absolute: layout.mode === "absolute", direction: layout.direction === "row" ? "row" : "column",
    gap: Math.max(0, numeric(literal(layout.gap))),
    padding: Math.max(0, numeric(literal(record(layout.padding).top))),
    fill: color(style.fill), color: color(typography.color),
    fontSize: typography.fontSize == null ? null : Math.max(1, Math.min(120, numeric(literal(typography.fontSize), 14))),
    radius: Math.max(0, numeric(literal(record(style.radii).topLeft))),
  }];
}

function prdMarkdown(content: RecordValue): string {
  const inline = (value: unknown) => array(value).map((part) => text(record(part).text, 10_000)).join("");
  let visited = 0;
  const visit = (value: unknown, depth = 2): string => {
    if (++visited > 3_000 || depth > 10) return "";
    if (Array.isArray(value)) return value.map((child) => visit(child, depth)).filter(Boolean).join("\n\n");
    const node = record(value);
    if (node.type === "text" || node.type === "link") return text(node.text, 10_000);
    if (node.type === "table") {
      const columns = array(node.columns).map((column) => text(record(column).label).replaceAll("|", "\\|"));
      if (!columns.length) return "";
      const rows = array(node.rows).map((row) => `| ${array(record(row).cells).map((cell) => inline(record(cell).content).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`);
      return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows].join("\n");
    }
    if (node.type === "bulletList" || node.type === "orderedList") return array(node.items)
      .map((item, index) => `${node.type === "orderedList" ? `${index + 1}.` : "-"} ${inline(record(item).content)}`).join("\n");
    const parts: string[] = [];
    if (node.title) parts.push(`${"#".repeat(Math.min(depth, 6))} ${text(node.title, 240)}`);
    if (node.content) parts.push(node.type === "heading" ? `### ${inline(node.content)}` : inline(node.content));
    if (node.description) parts.push(inline(node.description));
    if (node.summary) parts.push(inline(node.summary));
    // Visit only authoring fields; IDs, revisions, citations and tool metadata stay out of the preview.
    for (const key of ["blocks", "background", "scope", "usageScenarios", "pageLinks", "coreRules", "flowAndPages", "acceptanceCriteria", "additionalSections", "introduction", "businessRequirements", "degradation", "safetyBaseline"]) {
      if (node[key]) parts.push(visit(node[key], depth + 1));
    }
    return parts.filter(Boolean).join("\n\n");
  };
  return visit(content.sections);
}

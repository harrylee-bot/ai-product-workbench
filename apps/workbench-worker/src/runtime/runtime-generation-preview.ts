import {
  generationPreviewSchema,
  generationPreviewText as text,
  projectPrototypeGenerationPreview,
  prdChannelLabels,
  type GenerationPreview,
} from "@workbench/workbench-contracts";
import { parse } from "partial-json";

type RecordValue = Record<string, unknown>;
const PREVIEW_SAMPLE_INTERVAL_MS = 300;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
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
      const now = this.now();
      if (now - state.sampledAt < PREVIEW_SAMPLE_INTERVAL_MS) continue;
      state.sampledAt = now;
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
        if (this.accept(preview, now)) previews.push(preview);
      }
    }
    return previews;
  }

  accept(preview: GenerationPreview, sampledAt?: number): boolean {
    if (!this.kinds.includes(preview.kind)) return false;
    const signature = JSON.stringify(preview);
    const published = this.published.get(preview.artifactIndex);
    if (published && (
      signature === published.value
      || (sampledAt !== undefined && sampledAt - published.at < PREVIEW_SAMPLE_INTERVAL_MS)
    )) return false;
    this.published.set(preview.artifactIndex, { at: sampledAt ?? this.now(), value: signature });
    return true;
  }
}

export function projectGenerationPreview(artifactIndex: number, draft: RecordValue): GenerationPreview | null {
  if (draft.kind === "prototype") return projectPrototypeGenerationPreview(artifactIndex, draft);
  if (draft.kind !== "prd") return null;
  const content = record(draft.content);
  const title = text(draft.title ?? content.title, 240);
  if (!title) return null;
  const parsed = generationPreviewSchema.safeParse({
    artifactIndex, kind: "prd", title, markdown: prdMarkdown(content).slice(0, 48_000), screens: [],
  });
  return parsed.success ? parsed.data : null;
}

function prdMarkdown(content: RecordValue): string {
  const inline = (value: unknown) => array(value).map((part) => text(record(part).text, 10_000)).join("");
  let visited = 0;
  const visit = (value: unknown, depth = 2): string => {
    if (++visited > 3_000 || depth > 10) return "";
    if (typeof value === "string") return text(value, 10_000);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value === null || value === undefined) return "";
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
    if (node.description) parts.push(typeof node.description === "string" ? text(node.description, 10_000) : inline(node.description));
    if (node.summary) parts.push(inline(node.summary));
    // Visit authoring and semantic evidence fields so the live preview reflects
    // the complete PRD model. IDs, checksums, revision metadata and tool
    // metadata stay out of the preview. Channel and safety rows are part of
    // the requirement contract, so omitting them makes a partial draft look
    // complete while hiding acceptance-critical decisions.
    for (const key of [
      "blocks", "background", "scope", "usageScenarios", "channelTable", "pageLinks",
      "coreRules", "flowAndPages", "acceptanceCriteria", "additionalSections", "functionSections",
      "diagrams", "given", "when", "then", "introduction", "businessRequirements", "degradation",
      "safetyBaseline", "rows", "cells", "columns", "label", "sequence", "channel", "enabled",
      "applicability", "requirement", "scope", "remarks", "intro", "cover", "workOrderName",
      "versionHistory", "participants", "notes", "assumptions", "statement", "status", "impact",
      "owner", "citations", "quote",
    ]) {
      if (key === "channel" && typeof node[key] === "string") {
        parts.push(prdChannelLabels[node[key] as keyof typeof prdChannelLabels] ?? text(node[key], 120));
      } else if (node[key]) {
        parts.push(visit(node[key], depth + 1));
      }
    }
    return parts.filter(Boolean).join("\n\n");
  };
  return visit(content.sections);
}

import { createHash } from "node:crypto";
import { knowledgeToolResponseSchema, type RuntimeProgressEvent } from "@workbench/workbench-contracts";

type Activity = Extract<RuntimeProgressEvent, { type: "activity" }>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const field = (value: unknown, name: string): unknown => {
  const raw = record(value);
  return raw[name] ?? record(raw.kwargs)[name] ?? record(raw.lc_kwargs)[name];
};
const text = (value: unknown, limit = 240) => typeof value === "string"
  ? value.replace(/wb(?:kg|ct)1\.[A-Za-z0-9_.-]*/gu, "[已隐藏]").replace(/<think>[\s\S]*(?:<\/think>|$)/giu, "").replace(/[\u0000-\u001f]/gu, " ").slice(0, limit) : "";
const messageRoles = new Set(["user", "human", "humanmessage", "assistant", "ai", "aimessage", "aimessagechunk", "tool", "toolmessage"]);
const role = (message: unknown) => [field(message, "role"), field(message, "type"), array(record(message).id).at(-1)]
  .map((value) => String(value ?? "").toLowerCase()).find((value) => messageRoles.has(value)) ?? "";
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 500_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Public tool facts only: never reads assistant prose, reasoning, or credentials. */
export class RuntimeKnowledgeActivity {
  private emitted = new Map<string, string>();

  constructor(private readonly attemptId: string, private readonly releaseId: string | null) {}

  push(state: unknown): Activity[] {
    if (!this.releaseId) return [];
    const outer = record(state);
    const messages = array(outer.messages ?? record(outer.values).messages);
    let turn = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (["user", "human", "humanmessage"].includes(role(messages[index]))) { turn = index; break; }
    }
    if (turn < 0) return [];
    const activities: Activity[] = [];
    for (let index = turn + 1; index < messages.length; index++) {
      const message = messages[index];
      if (!["assistant", "ai", "aimessage", "aimessagechunk"].includes(role(message))) continue;
      const calls = array(field(message, "tool_calls") ?? record(field(message, "additional_kwargs")).tool_calls);
      for (const item of calls) {
        const call = record(item), fn = record(call.function);
        if ((call.name ?? fn.name) !== "workbench_knowledge_retrieve" || typeof call.id !== "string") continue;
        const query = text(record(json(call.args ?? call.arguments ?? fn.arguments)).query);
        if (!query) continue;
        const activityId = `knowledge:${createHash("sha256").update(this.attemptId).update("\0").update(call.id).digest("hex")}`;
        const responses = messages.slice(index + 1).filter((candidate) => ["tool", "toolmessage"].includes(role(candidate))
          && field(candidate, "tool_call_id") === call.id
          && (field(candidate, "name") === undefined || field(candidate, "name") === "workbench_knowledge_retrieve"));
        let status: Activity["status"] = "running";
        let detail = `检索问题：${query}`;
        if (responses.length) {
          const response = responses[0];
          const content = field(response, "content");
          const body = Array.isArray(content) ? content.filter((block) => record(block).type === "text").map((block) => record(block).text).join("") : content;
          const parsed = knowledgeToolResponseSchema.safeParse(json(body));
          if (responses.length !== 1 || field(response, "status") === "error" || !parsed.success || parsed.data.evidence.release.id !== this.releaseId) {
            status = "failed";
            detail += "\n本次检索未返回可用结果";
          } else {
            status = "succeeded";
            const items = parsed.data.items;
            detail += `\n返回 ${items.length} 条资料片段${parsed.data.evidence.degraded ? "（检索服务降级）" : ""}`;
            for (const { citation } of items.slice(0, 4)) {
              detail += `\n• ${text(citation.title ?? citation.sourcePath, 160)}${citation.locator.heading ? ` / ${text(citation.locator.heading, 120)}` : ""}`;
            }
            if (!items.length) detail += "；尚无可引用资料";
          }
        }
        const activity: Activity = { type: "activity", activityId, status, label: "知识库检索", detail: detail.slice(0, 2_000) };
        const signature = JSON.stringify(activity);
        if (this.emitted.get(activityId) === signature) continue;
        this.emitted.set(activityId, signature);
        activities.push(activity);
      }
    }
    return activities;
  }
}

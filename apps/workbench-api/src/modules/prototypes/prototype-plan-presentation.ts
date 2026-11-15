import { prototypeFeedbackAnchorSchema } from "@workbench/workbench-contracts";

const revisionInstruction = "根据以下批注修改原型，保留其他页面和交互。";
const legacyInstruction = "Revise the prototype according to the following review feedback. Preserve unrelated screens and interactions.";
type ReviewComment = { body: string; anchor: unknown };

/** Presentation only. The generation request retains the exact anchored payload. */
export function formatPrototypeReviewPrompt(prompt: string | undefined, comments: ReviewComment[], pages: unknown = []): string {
  const pageNames = new Map<string, string>();
  if (Array.isArray(pages)) for (const page of pages) {
    if (page && typeof page.id === "string" && typeof page.title === "string") pageNames.set(page.id, page.title);
  }
  const heading = prompt && prompt !== legacyInstruction ? prompt : revisionInstruction;
  const lines = comments.map((comment) => {
    const anchor = prototypeFeedbackAnchorSchema.nullable().safeParse(comment.anchor);
    const location = anchor.success && anchor.data
      ? [pageNames.get(anchor.data.pageId), anchor.data.quote?.trim()].filter(Boolean).map((label) => label!.slice(0, 80)).join(" · ") : "";
    return `- ${location ? `${location}：` : ""}${comment.body}`;
  });
  const labeled = [heading, ...lines].join("\n");
  // Long page names must not displace any of the user's review text.
  return labeled.length <= 20_000 ? labeled : [heading, ...comments.map((comment) => `- ${comment.body}`)].join("\n");
}

/** Read compatibility for the exact JSON suffix produced by the earlier writer. */
export function prototypePlanDisplayPrompt(row: { prompt: string; sourceRevisionId?: unknown; feedbackIds?: unknown; generationRequest?: unknown }): string {
  if (!row.sourceRevisionId || !Array.isArray(row.feedbackIds) || !row.feedbackIds.length) return row.prompt;
  const request = row.generationRequest;
  if (!request || typeof request !== "object" || !("prompt" in request) || request.prompt !== row.prompt) return row.prompt;
  const ids = new Set(row.feedbackIds);
  if (ids.size !== row.feedbackIds.length || [...ids].some((id) => typeof id !== "string")) return row.prompt;
  const lines = row.prompt.split("\n");
  if (lines.length <= ids.size) return row.prompt;
  const comments: ReviewComment[] = [];
  for (const line of lines.slice(-ids.size)) {
    let item: unknown;
    try { item = JSON.parse(line); } catch { return row.prompt; }
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "anchor,body,id") return row.prompt;
    const entry = item as { id: unknown; body: unknown; anchor: unknown };
    if (!ids.delete(entry.id) || typeof entry.body !== "string" || !entry.body.trim()
      || entry.body.length > 4_000 || !prototypeFeedbackAnchorSchema.nullable().safeParse(entry.anchor).success) return row.prompt;
    comments.push({ body: entry.body, anchor: entry.anchor });
  }
  return formatPrototypeReviewPrompt(lines.slice(0, -comments.length).join("\n"), comments);
}

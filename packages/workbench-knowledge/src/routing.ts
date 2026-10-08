import type { KnowledgeIssue, KnowledgeRoute } from "./types.js";

const ACCEPTED_STATUSES = new Set([
  "已整理",
  "已重构",
  "已维护",
  "已生效",
  "已处理",
  "已导入",
  "草稿",
  "仅查来源",
  "不参与检索",
]);

export function isAcceptedKnowledgeStatus(status: string): boolean {
  return ACCEPTED_STATUSES.has(status);
}

export function routeKnowledgeDocument(input: {
  readonly sourcePath: string;
  readonly status?: string;
  readonly issues: readonly KnowledgeIssue[];
}): KnowledgeRoute {
  if (input.issues.some((issue) => issue.severity === "error")) return "quarantine";

  const directory = input.sourcePath.split("/", 1)[0] ?? "";
  let route: KnowledgeRoute;

  if (input.sourcePath === "README.md" || /^(?:0[0-6])(?:-|$)/.test(directory)) {
    route = "production";
  } else if (/^07(?:-|$)/.test(directory)) {
    route = "source_lookup";
  } else {
    route = "quarantine";
  }

  if (directory === "_templates" || input.status === "草稿") return "quarantine";
  if (input.status === "不参与检索") return route === "quarantine" ? route : "excluded";
  if (input.status === "仅查来源" && route === "production") return "source_lookup";
  return route;
}

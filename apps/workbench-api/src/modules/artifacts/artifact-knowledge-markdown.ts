import type { Prisma } from "@workbench/workbench-db";
import { validationProblem } from "../../common/problem-details.js";

// Keep the business structure, including ids and cross-references. In particular,
// nested binding.source and diagram edges are data, not external source metadata.
const businessFields = {
  "workbench.prd.v1": ["title", "revision", "tableOfContents", "assumptions", "sections"],
  "workbench.prd.v2": ["title", "revision", "cover", "versionHistory", "tableOfContents", "assumptions", "sections"],
  "workbench.prd.v3": ["title", "revision", "cover", "versionHistory", "tableOfContents", "assumptions", "sections"],
  "workbench.prototype-source.v1": ["title", "revision", "summary", "pages"],
  "workbench.prototype.v1": ["title", "revision", "screens", "nodes", "tokens", "variables", "states", "actions", "bindings", "motions"],
} as const;

export function artifactKnowledgeMarkdown(title: string, content: Prisma.JsonValue): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw validationProblem("ARTIFACT_KNOWLEDGE_TEXT_REQUIRED");
  }
  const protocol = content.protocol;
  const fields = typeof protocol === "string" && Object.hasOwn(businessFields, protocol)
    ? businessFields[protocol as keyof typeof businessFields]
    : ["title", "text", "markdown"];
  const lines: string[] = [];
  const visit = (value: Prisma.JsonValue, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${path}: []`);
      value.forEach((item, index) => visit(item, `${path}[${index + 1}]`));
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value).sort();
      if (!keys.length) lines.push(`${path}: {}`);
      for (const key of keys) {
        const child = value[key];
        if (child !== undefined) visit(child, `${path}.${JSON.stringify(key)}`);
      }
    } else {
      // JSON quoting retains newlines and distinguishes false, 0, null and text.
      lines.push(`${path}: ${JSON.stringify(value)}`);
    }
  };
  for (const field of fields) {
    const value = content[field];
    if (value !== undefined) visit(value, field);
  }
  if (!lines.length) throw validationProblem("ARTIFACT_KNOWLEDGE_TEXT_REQUIRED");
  const literal = (value: string) => {
    const text = value.replace(/storage\//gu, "storage&#47;");
    const longest = Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));
    const fence = "`".repeat(longest + 1);
    return `${fence} ${text} ${fence}`;
  };
  return `---\ntitle: ${JSON.stringify(title)}\nstatus: 已生效\ntags: [finalized]\naliases: []\n---\n\n# ${literal(title.replace(/[\r\n]/gu, " "))}\n\n${lines.map(literal).join("\n\n")}\n`.normalize("NFC");
}

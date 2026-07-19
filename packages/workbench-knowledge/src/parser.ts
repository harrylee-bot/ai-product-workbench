import { posix } from "node:path";

import { sha256 } from "./checksum.js";
import { parseKnowledgeFrontmatter } from "./frontmatter.js";
import { analyzeMarkdown } from "./internal/markdown.js";
import { normalizeVaultPath } from "./path.js";
import { collectKnowledgeReferences, resolveKnowledgeReferences, sortIssues } from "./references.js";
import { routeKnowledgeDocument } from "./routing.js";
import { normalizeMarkdownInput, normalizeMarkdownInputLossy } from "./source-normalization.js";
import type { KnowledgeIssue, ParsedKnowledgeDocument, VaultSourceInput } from "./types.js";

export function parseKnowledgeSource(
  input: VaultSourceInput,
  options: { readonly vaultRoot?: string } = {},
): ParsedKnowledgeDocument {
  const normalizedPath = normalizeVaultPath(input.path, options.vaultRoot);
  let invalidEncoding = false;
  let normalizedMarkdown: string;
  try {
    normalizedMarkdown = normalizeMarkdownInput(input.content);
  } catch {
    invalidEncoding = true;
    normalizedMarkdown = normalizeMarkdownInputLossy(input.content as Uint8Array);
  }
  const analysis = analyzeMarkdown(normalizedMarkdown);
  const frontmatter = parseKnowledgeFrontmatter(analysis.yaml);
  const issues: KnowledgeIssue[] = frontmatter.issues.map((issue) => ({
    ...issue,
    sourceLocator: normalizedPath.locator,
  }));

  if (!normalizedPath.valid) {
    issues.push({
      code: "INVALID_SOURCE_PATH",
      severity: "error",
      sourceLocator: normalizedPath.locator,
      message: normalizedPath.reason ?? "invalid source path",
    });
  }
  if (invalidEncoding) {
    issues.push({
      code: "INVALID_SOURCE_ENCODING",
      severity: "error",
      sourceLocator: normalizedPath.locator,
      message: "source bytes are not valid UTF-8",
    });
  }

  const sortedIssues = sortIssues(issues);
  const fallbackTitle = analysis.titleFromHeading
    || posix.basename(normalizedPath.path, posix.extname(normalizedPath.path));

  return {
    sourcePath: normalizedPath.path,
    sourceLocator: normalizedPath.locator,
    sourceChecksum: sha256(normalizedMarkdown),
    normalizedMarkdown,
    title: frontmatter.value?.title ?? fallbackTitle,
    ...(frontmatter.value ? { frontmatter: frontmatter.value } : {}),
    route: routeKnowledgeDocument({
      sourcePath: normalizedPath.path,
      status: frontmatter.value?.status,
      issues: sortedIssues,
    }),
    headings: analysis.headings,
    blocks: analysis.blocks,
    references: collectKnowledgeReferences(analysis.tree),
    issues: sortedIssues,
  };
}

export function parseKnowledgeSources(
  inputs: readonly VaultSourceInput[],
  options: { readonly vaultRoot?: string } = {},
): readonly ParsedKnowledgeDocument[] {
  const parsed = inputs
    .map((input) => parseKnowledgeSource(input, options))
    .sort((left, right) => (
      left.sourcePath.localeCompare(right.sourcePath, "en")
      || left.sourceChecksum.localeCompare(right.sourceChecksum, "en")
    ));
  const duplicatePaths = new Set<string>();
  const counts = new Map<string, number>();
  for (const document of parsed) counts.set(document.sourcePath, (counts.get(document.sourcePath) ?? 0) + 1);
  for (const [path, count] of counts) if (count > 1) duplicatePaths.add(path);

  const withDuplicateIssues = parsed.map((document) => {
    if (!duplicatePaths.has(document.sourcePath)) return document;
    const issues = sortIssues([...document.issues, {
      code: "DUPLICATE_SOURCE_PATH" as const,
      severity: "error" as const,
      sourceLocator: document.sourceLocator,
      message: `duplicate source path: ${document.sourcePath}`,
    }]);
    return {
      ...document,
      issues,
      route: "quarantine" as const,
    };
  });

  return [...resolveKnowledgeReferences(withDuplicateIssues, { vaultRoot: options.vaultRoot })]
    .sort((left, right) => (
      left.sourcePath.localeCompare(right.sourcePath, "en")
      || left.sourceChecksum.localeCompare(right.sourceChecksum, "en")
    ));
}

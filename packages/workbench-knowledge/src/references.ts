import { posix } from "node:path";

import type { Image, Link, Root } from "mdast";

import { normalizedText, walkMarkdownTree } from "./internal/markdown.js";
import { isWikiLinkNode } from "./internal/wikilink.js";
import {
  isAbsoluteOrExternalTarget,
  isExternalUrl,
  normalizeVaultPath,
  resolveRelativeVaultPath,
  withoutMarkdownExtension,
} from "./path.js";
import { routeKnowledgeDocument } from "./routing.js";
import type {
  KnowledgeIssue,
  KnowledgeReference,
  KnowledgeReferenceKind,
  ParsedKnowledgeDocument,
} from "./types.js";

export function collectKnowledgeReferences(tree: Root): readonly KnowledgeReference[] {
  const references: KnowledgeReference[] = [];
  walkMarkdownTree(tree, (node) => {
    if (isWikiLinkNode(node)) {
      references.push(unresolvedReference("wikilink", node.target, node.alias));
    } else if (node.type === "link") {
      const link = node as Link;
      references.push(unresolvedReference("markdown_link", link.url, normalizedText(link)));
    } else if (node.type === "image") {
      const image = node as Image;
      references.push(unresolvedReference("markdown_image", image.url, image.alt ?? undefined));
    }
  });
  return references;
}

export function resolveKnowledgeReferences(
  documents: readonly ParsedKnowledgeDocument[],
  options: { readonly vaultRoot?: string } = {},
): readonly ParsedKnowledgeDocument[] {
  const pathIndex = createPathIndex(documents);
  const aliasIndex = createAliasIndex(documents);

  return documents.map((document) => {
    const issues = [...document.issues];
    const references = document.references.map((reference) => resolveReference(
      reference,
      document,
      pathIndex,
      aliasIndex,
      issues,
      options.vaultRoot ?? "knowledge-vault",
    ));
    const sortedIssues = sortIssues(issues);
    return {
      ...document,
      references,
      issues: sortedIssues,
      route: routeKnowledgeDocument({
        sourcePath: document.sourcePath,
        status: document.frontmatter?.status,
        issues: sortedIssues,
      }),
    };
  });
}

function unresolvedReference(
  syntax: KnowledgeReference["syntax"],
  rawTarget: string,
  label?: string,
): KnowledgeReference {
  const { path, fragment } = splitTarget(rawTarget);
  if (isExternalUrl(path)) {
    return {
      syntax,
      kind: "external",
      rawTarget,
      ...(label ? { label } : {}),
      ...(fragment ? { fragment } : {}),
      resolution: "not_applicable",
    };
  }

  return {
    syntax,
    kind: referenceKind(path),
    rawTarget,
    ...(label ? { label } : {}),
    ...(fragment ? { fragment } : {}),
    resolution: "unresolved",
  };
}

function resolveReference(
  reference: KnowledgeReference,
  source: ParsedKnowledgeDocument,
  pathIndex: ReadonlyMap<string, readonly ParsedKnowledgeDocument[]>,
  aliasIndex: ReadonlyMap<string, readonly ParsedKnowledgeDocument[]>,
  issues: KnowledgeIssue[],
  vaultRoot: string,
): KnowledgeReference {
  if (reference.kind === "external") return reference;
  const { path: rawPath, fragment } = splitTarget(reference.rawTarget);

  // Markdown files under storage/ are source evidence assets, even when the
  // asset itself is Markdown. They are declared and integrity-checked by the
  // storage closure; they are not Vault documents to resolve through the
  // current document/alias index.
  if (rawPath === "storage" || rawPath.startsWith("storage/")) {
    return {
      ...reference,
      kind: "internal_asset",
      resolution: "resolved",
      resolvedLocator: `storage://${rawPath}`,
    };
  }

  if (isAbsoluteOrExternalTarget(rawPath)) {
    issues.push(issue(source, "ABSOLUTE_INTERNAL_REFERENCE", `absolute internal reference is forbidden: ${reference.rawTarget}`, reference.rawTarget));
    return { ...reference, resolution: "unresolved" };
  }

  if (reference.kind === "internal_asset") {
    const resolved = resolveRelativeVaultPath(source.sourcePath, rawPath, vaultRoot);
    if (!resolved.valid) {
      issues.push(issue(source, "INVALID_INTERNAL_REFERENCE", resolved.reason ?? "invalid asset reference", reference.rawTarget));
      return { ...reference, resolution: "unresolved" };
    }
    return { ...reference, resolution: "resolved", resolvedLocator: resolved.locator };
  }

  const candidates = documentCandidates(reference, source, pathIndex, aliasIndex, vaultRoot);
  if (candidates.length === 0) {
    issues.push(issue(source, "UNRESOLVED_INTERNAL_REFERENCE", `internal reference does not resolve: ${reference.rawTarget}`, reference.rawTarget));
    return { ...reference, resolution: "unresolved" };
  }
  if (candidates.length > 1) {
    issues.push(issue(source, "AMBIGUOUS_INTERNAL_REFERENCE", `internal reference is ambiguous: ${reference.rawTarget}`, reference.rawTarget));
    return { ...reference, resolution: "ambiguous" };
  }

  const target = candidates[0]!;
  if (fragment && !headingExists(target, fragment)) {
    issues.push(issue(source, "UNRESOLVED_HEADING_REFERENCE", `heading reference does not resolve: ${reference.rawTarget}`, reference.rawTarget));
    return { ...reference, resolution: "unresolved", resolvedLocator: target.sourceLocator };
  }
  return { ...reference, resolution: "resolved", resolvedLocator: target.sourceLocator };
}

function documentCandidates(
  reference: KnowledgeReference,
  source: ParsedKnowledgeDocument,
  pathIndex: ReadonlyMap<string, readonly ParsedKnowledgeDocument[]>,
  aliasIndex: ReadonlyMap<string, readonly ParsedKnowledgeDocument[]>,
  vaultRoot: string,
): readonly ParsedKnowledgeDocument[] {
  const { path } = splitTarget(reference.rawTarget);
  if (!path) return [source];
  const keys: string[] = [];

  if (reference.syntax === "wikilink") {
    const rootPath = normalizeDocumentTarget(path, vaultRoot);
    if (rootPath) keys.push(rootPath, withoutMarkdownExtension(rootPath));
  }

  const relative = resolveRelativeVaultPath(source.sourcePath, path, vaultRoot);
  if (relative.valid) keys.push(relative.path, withoutMarkdownExtension(relative.path));

  const results = new Map<string, ParsedKnowledgeDocument>();
  for (const key of keys) {
    for (const candidate of pathIndex.get(indexKey(key)) ?? []) results.set(candidate.sourceLocator, candidate);
  }
  if (reference.syntax === "wikilink") {
    for (const candidate of aliasIndex.get(indexKey(path)) ?? []) results.set(candidate.sourceLocator, candidate);
  }
  return [...results.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, "en"));
}

function createPathIndex(documents: readonly ParsedKnowledgeDocument[]): ReadonlyMap<string, readonly ParsedKnowledgeDocument[]> {
  const mutable = new Map<string, ParsedKnowledgeDocument[]>();
  for (const document of documents) {
    const basename = posix.basename(document.sourcePath, ".md");
    for (const value of [document.sourcePath, withoutMarkdownExtension(document.sourcePath), basename]) {
      appendIndex(mutable, indexKey(value), document);
    }
  }
  return mutable;
}

function createAliasIndex(documents: readonly ParsedKnowledgeDocument[]): ReadonlyMap<string, readonly ParsedKnowledgeDocument[]> {
  const mutable = new Map<string, ParsedKnowledgeDocument[]>();
  for (const document of documents) {
    for (const alias of document.frontmatter?.aliases ?? []) appendIndex(mutable, indexKey(alias), document);
  }
  return mutable;
}

function appendIndex(index: Map<string, ParsedKnowledgeDocument[]>, key: string, value: ParsedKnowledgeDocument): void {
  const current = index.get(key) ?? [];
  if (!current.some((item) => item.sourceLocator === value.sourceLocator)) current.push(value);
  index.set(key, current);
}

function normalizeDocumentTarget(target: string, vaultRoot: string): string | undefined {
  const withExtension = posix.extname(target) === "" ? `${target}.md` : target;
  const normalized = normalizeVaultPath(withExtension, vaultRoot);
  return normalized.valid ? normalized.path : undefined;
}

function splitTarget(target: string): { path: string; fragment?: string } {
  const hash = target.indexOf("#");
  const path = (hash === -1 ? target : target.slice(0, hash)).trim().normalize("NFC");
  const fragment = hash === -1 ? undefined : target.slice(hash + 1).trim().normalize("NFC");
  return { path, ...(fragment ? { fragment } : {}) };
}

function referenceKind(path: string): KnowledgeReferenceKind {
  const extension = posix.extname(path).toLocaleLowerCase("en-US");
  return extension && extension !== ".md" ? "internal_asset" : "internal_document";
}

function headingExists(document: ParsedKnowledgeDocument, fragment: string): boolean {
  const expected = headingKey(fragment);
  return document.headings.some((heading) => headingKey(heading) === expected);
}

function headingKey(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Invalid percent encoding simply cannot match a valid heading.
  }
  return decoded
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/^#+/, "")
    .replace(/[\s-]+/g, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
}

function indexKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function issue(
  source: ParsedKnowledgeDocument,
  code: KnowledgeIssue["code"],
  message: string,
  reference: string,
): KnowledgeIssue {
  return { code, severity: "error", sourceLocator: source.sourceLocator, message, reference };
}

export function sortIssues(issues: readonly KnowledgeIssue[]): readonly KnowledgeIssue[] {
  return [...issues].sort((left, right) => (
    left.sourceLocator.localeCompare(right.sourceLocator, "en")
    || left.code.localeCompare(right.code, "en")
    || (left.reference ?? "").localeCompare(right.reference ?? "", "en")
    || left.message.localeCompare(right.message, "en")
  ));
}

import type {
  CreateImportSourceRequest,
  ImportSource,
  ImportSourceKind,
  ImportSourceStatus,
} from "@workbench/workbench-contracts";

export const DEFAULT_IMPORT_SOURCE_POLL_INTERVAL_MS = 1_500;

export type ImportSourceListOptions = {
  cursor?: string;
  limit?: number;
};

export type ImportSourceDraft = Extract<
  CreateImportSourceRequest,
  { kind: "url_snapshot" | "github_snapshot" | "figma_snapshot" }
>;

export const importSourceKindLabels: Record<ImportSourceKind, string> = {
  file: "文件",
  design_md: "DESIGN.md",
  url_snapshot: "网站",
  github_snapshot: "GitHub",
  figma_snapshot: "Figma",
};

export const importSourceStatusLabels: Record<ImportSourceStatus, string> = {
  pending: "处理中",
  ready: "可用",
  failed: "导入失败",
  deleted: "已删除",
};

export function importSourceNeedsPolling(source: ImportSource): boolean {
  return source.status === "pending";
}

export function importSourceRefetchInterval(
  source: ImportSource | undefined,
  intervalMs = DEFAULT_IMPORT_SOURCE_POLL_INTERVAL_MS,
): number | false {
  if (!source || !importSourceNeedsPolling(source)) return false;
  if (!Number.isFinite(intervalMs) || intervalMs < 250) {
    throw new Error("Import source polling interval must be at least 250ms");
  }
  return intervalMs;
}

export function importSourceListNeedsPolling(
  sources: readonly ImportSource[] | undefined,
): boolean {
  return sources?.some(importSourceNeedsPolling) ?? false;
}

export function importSourceListRefetchInterval(
  sources: readonly ImportSource[] | undefined,
  intervalMs = DEFAULT_IMPORT_SOURCE_POLL_INTERVAL_MS,
): number | false {
  if (!importSourceListNeedsPolling(sources)) return false;
  if (!Number.isFinite(intervalMs) || intervalMs < 250) {
    throw new Error("Import source polling interval must be at least 250ms");
  }
  return intervalMs;
}

export function isReadyImportSource(source: ImportSource | undefined): source is ImportSource {
  return source?.status === "ready" && source.deletedAt === null;
}

export function normalizeGitHubRepository(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\/(?:www\.)?github\.com\//iu, "");
  return trimmed.replace(/\.git\/?$/iu, "").replace(/^\/+|\/+$/g, "");
}

export function isImportSourceUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
    if (
      hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
      || hostname === "0.0.0.0"
      || hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || hostname.startsWith("fe80:")
      || hostname === "127.0.0.1"
      || hostname.startsWith("127.")
      || hostname.startsWith("10.")
      || hostname.startsWith("192.168.")
      || hostname.startsWith("169.254.")
    ) return false;
    const private172 = hostname.match(/^172\.(\d{1,3})\./u);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    if (/^\d+$/.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeFigmaFileKey(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const markerIndex = parts.findIndex((part) => part === "file" || part === "design");
    if (markerIndex >= 0 && parts[markerIndex + 1]) return parts[markerIndex + 1]!;
  } catch {
    // Treat an opaque key as-is; the API contract performs the final validation.
  }
  return trimmed;
}

export function figmaVersionFromInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("version-id") ?? url.searchParams.get("versionId") ?? undefined;
  } catch {
    return undefined;
  }
}

export function importSourceLabel(source: ImportSource): string {
  if (source.label.trim()) return source.label;
  const descriptor = source.descriptor;
  if (descriptor?.kind === "url_snapshot") return descriptor.sourceUrl;
  if (descriptor?.kind === "github_snapshot") return descriptor.repository;
  if (descriptor?.kind === "figma_snapshot") return descriptor.fileKey;
  if (descriptor?.kind === "file" || descriptor?.kind === "design_md") return descriptor.originalName;
  return importSourceKindLabels[source.kind];
}

export function importSourceDraftLabel(draft: ImportSourceDraft): string {
  if (draft.label?.trim()) return draft.label.trim();
  if (draft.kind === "url_snapshot") {
    try {
      return new URL(draft.sourceUrl).hostname;
    } catch {
      return draft.sourceUrl;
    }
  }
  if (draft.kind === "github_snapshot") return draft.repository;
  return `Figma ${draft.fileKey}`;
}

export function importSourceDraftProjectTitle(draft: ImportSourceDraft): string {
  const label = importSourceDraftLabel(draft);
  return label.length <= 80 ? label : `${label.slice(0, 77)}...`;
}

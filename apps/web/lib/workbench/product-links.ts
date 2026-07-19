export type WorkbenchProductLinks = {
  feedback: string | null;
  forum: string | null;
  privacy: string | null;
};

export const workbenchProductLinks: WorkbenchProductLinks = {
  feedback: normalizeWorkbenchProductLink(
    process.env.NEXT_PUBLIC_WORKBENCH_FEEDBACK_URL,
    ["https:", "mailto:"],
  ),
  forum: normalizeWorkbenchProductLink(
    process.env.NEXT_PUBLIC_WORKBENCH_FORUM_URL,
    ["https:"],
  ),
  privacy: normalizeWorkbenchProductLink(
    process.env.NEXT_PUBLIC_WORKBENCH_PRIVACY_URL,
    ["https:"],
  ),
};

export function normalizeWorkbenchProductLink(
  value: string | undefined,
  allowedProtocols: readonly string[],
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (!allowedProtocols.includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function openWorkbenchProductLink(url: string): void {
  if (url.startsWith("mailto:")) {
    window.location.assign(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function openWorkbenchKnowledgePage(path = ""): void {
  const configuredBase = process.env.NEXT_PUBLIC_KNOWLEDGE_APP_URL?.trim() || "/knowledge/";
  const base = new URL(
    configuredBase.endsWith("/") ? configuredBase : `${configuredBase}/`,
    window.location.origin,
  );
  const target = new URL(path, base);
  window.open(target, "_blank", "noopener,noreferrer");
}

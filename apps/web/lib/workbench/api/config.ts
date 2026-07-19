const WORKBENCH_API_PATH = "/api/v1";

export function getWorkbenchApiBaseUrl(): string {
  return typeof window === "undefined"
    ? WORKBENCH_API_PATH
    : `${window.location.origin}${WORKBENCH_API_PATH}`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeWorkbenchApiBaseUrl(value: string): string {
  const normalized = stripTrailingSlash(value);
  if (typeof window === "undefined") return normalized;

  const url = new URL(normalized, window.location.origin);
  if (
    url.origin !== window.location.origin
    || stripTrailingSlash(url.pathname) !== WORKBENCH_API_PATH
    || url.search
    || url.hash
  ) {
    throw new Error("Workbench browser requests must use the same-origin /api/v1 BFF");
  }
  return `${url.origin}${WORKBENCH_API_PATH}`;
}

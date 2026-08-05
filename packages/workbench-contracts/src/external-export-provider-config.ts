import type { ExternalExportTarget } from "./exports.js";

export type NetlifyExternalExportProviderConfig = {
  apiBaseUrl: string;
  siteId: string;
  accessToken: string;
  requestTimeoutMs: number;
  pollIntervalMs: number;
};

export type ExternalExportProviderConfig = {
  netlify: NetlifyExternalExportProviderConfig | null;
};

/**
 * Parse the deployment-owned external Export provider configuration. API and
 * Worker both use this function so the advertised capability cannot diverge
 * from the adapter that will execute it.
 */
export function loadExternalExportProviderConfig(
  environment: Record<string, string | undefined> = process.env,
): ExternalExportProviderConfig {
  const netlifySiteId = optional(environment, "WORKBENCH_NETLIFY_SITE_ID");
  const netlifyAccessToken = optional(environment, "WORKBENCH_NETLIFY_ACCESS_TOKEN");
  const netlifyApiBaseUrl = optional(environment, "WORKBENCH_NETLIFY_API_BASE_URL");
  const netlifyRequestTimeoutMs = optional(environment, "WORKBENCH_NETLIFY_REQUEST_TIMEOUT_MS");
  const netlifyPollIntervalMs = optional(environment, "WORKBENCH_NETLIFY_POLL_INTERVAL_MS");
  const netlifyConfigured = [
    netlifySiteId,
    netlifyAccessToken,
    netlifyApiBaseUrl,
    netlifyRequestTimeoutMs,
    netlifyPollIntervalMs,
  ].some((value) => value !== undefined);

  if (!netlifyConfigured) return { netlify: null };
  if (!netlifySiteId || !netlifyAccessToken) {
    throw new Error(
      "WORKBENCH_NETLIFY_SITE_ID and WORKBENCH_NETLIFY_ACCESS_TOKEN must be configured together",
    );
  }

  return {
    netlify: {
      siteId: netlifySiteId,
      accessToken: netlifyAccessToken,
      apiBaseUrl: externalProviderApiUrl(
        netlifyApiBaseUrl ?? "https://api.netlify.com/api/v1",
        "WORKBENCH_NETLIFY_API_BASE_URL",
        environment.NODE_ENV === "production",
      ),
      requestTimeoutMs: positiveInteger(
        netlifyRequestTimeoutMs,
        "WORKBENCH_NETLIFY_REQUEST_TIMEOUT_MS",
        120_000,
        1_000,
        15 * 60_000,
      ),
      pollIntervalMs: positiveInteger(
        netlifyPollIntervalMs,
        "WORKBENCH_NETLIFY_POLL_INTERVAL_MS",
        1_000,
        50,
        30_000,
      ),
    },
  };
}

export function externalExportProviderAvailable(
  config: ExternalExportProviderConfig,
  target: ExternalExportTarget,
) {
  return target === "netlify" && config.netlify !== null;
}

function optional(environment: Record<string, string | undefined>, name: string) {
  return environment[name]?.trim() || undefined;
}

function externalProviderApiUrl(value: string, name: string, production: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  if (production && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

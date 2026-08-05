import { createHash } from "node:crypto";
import type { NetlifyExternalExportProviderConfig } from "@workbench/workbench-contracts";
import { TerminalExportError } from "@workbench/workbench-export-core";
import type {
  ExternalExportDeliveryAdapter,
  ExternalExportDeliveryRequest,
} from "./external-export-delivery.adapter.js";

const MAX_REMOTE_REFERENCE_LENGTH = 500;
const TERMINAL_DEPLOY_STATES = new Set(["error", "failed", "cancelled"]);

type NetlifyDeploy = {
  id: string;
  site_id: string;
  state: string;
  title: string | null;
  deploy_ssl_url: string | null;
  deploy_url: string | null;
  ssl_url: string | null;
  url: string | null;
  error_message: string | null;
};

export class NetlifyExternalExportDeliveryAdapter implements ExternalExportDeliveryAdapter {
  readonly target = "netlify" as const;

  constructor(
    private readonly config: NetlifyExternalExportProviderConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async deliver(request: ExternalExportDeliveryRequest) {
    assertNetlifyArchive(request);
    const operation = createAbortScope(
      request.signal,
      this.config.requestTimeoutMs,
      "EXPORT_EXTERNAL_NETLIFY_OPERATION_TIMEOUT",
    );
    try {
      const baseTitle = deployTitle(request.idempotencyKey, request.payload.output.sha256);
      const existing = await this.findDeploysByTitle(baseTitle, operation.signal);
      const recovered = existing.find((deploy) => deploy.state === "ready")
        ?? existing.find((deploy) => !isTerminalDeployState(deploy.state));
      const title = recovered ? recovered.title! : nextDeployTitle(baseTitle, existing);
      const deploy = recovered ?? await this.createDeploy(title, request.bytes, operation.signal);
      if (await abortablePromise(request.isCancelled(), operation.signal)) {
        throw new Error("EXPORT_DELIVERY_CANCELLED");
      }
      const ready = await this.waitUntilReady(deploy, operation.signal, request.isCancelled);
      return { remoteReference: netlifyRemoteReference(this.config.siteId, ready) };
    } finally {
      operation.dispose();
    }
  }

  async revoke(request: { idempotencyKey: string; remoteReference: string; signal?: AbortSignal }) {
    const { siteId, deployId } = parseNetlifyRemoteReference(request.remoteReference);
    if (siteId !== this.config.siteId) throw new Error("EXPORT_EXTERNAL_NETLIFY_RECEIPT_SITE_MISMATCH");
    const response = await this.requestStatus(
      `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(deployId)}`,
      { method: "DELETE" },
      "EXPORT_EXTERNAL_NETLIFY_REVOKE_FAILED",
      request.signal,
    );
    if (response.status === 404) return;
    if (response.status !== 204 && !response.ok) {
      throw providerResponseError("EXPORT_EXTERNAL_NETLIFY_REVOKE_FAILED", response.status);
    }
  }

  private async createDeploy(title: string, bytes: Uint8Array, signal?: AbortSignal) {
    const value = await this.requestJson(
      `/sites/${encodeURIComponent(this.config.siteId)}/deploys?title=${encodeURIComponent(title)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: Buffer.from(bytes),
      },
      "EXPORT_EXTERNAL_NETLIFY_CREATE_FAILED",
      signal,
    );
    return parseDeploy(
      value,
      "EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID",
      this.config.siteId,
    );
  }

  private async findDeploysByTitle(baseTitle: string, signal?: AbortSignal) {
    const titles = new Set<string>();
    const retryPrefix = `${baseTitle}-retry-`;
    const matches: NetlifyDeploy[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const value = await this.requestJson(
        `/sites/${encodeURIComponent(this.config.siteId)}/deploys?page=${page}&per_page=100`,
        { method: "GET" },
        "EXPORT_EXTERNAL_NETLIFY_LOOKUP_FAILED",
        signal,
      );
      if (!Array.isArray(value)) throw new Error("EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID");
      const deploys = value.map((entry) => parseDeploy(
        entry,
        "EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID",
        this.config.siteId,
      ));
      for (const deploy of deploys) {
        if (deploy.title === baseTitle || (deploy.title?.startsWith(retryPrefix) && !titles.has(deploy.title))) {
          matches.push(deploy);
          if (deploy.title) titles.add(deploy.title);
        }
      }
      if (deploys.length < 100) return matches;
    }
    return matches;
  }

  private async waitUntilReady(
    initial: NetlifyDeploy,
    signal: AbortSignal | undefined,
    isCancelled: () => Promise<boolean>,
  ) {
    let deploy = initial;
    for (;;) {
      if (deploy.state === "ready") return deploy;
      if (["error", "failed", "cancelled"].includes(deploy.state)) {
        throw new Error("EXPORT_EXTERNAL_NETLIFY_DEPLOY_FAILED");
      }
      if (await abortablePromise(isCancelled(), signal)) throw new Error("EXPORT_DELIVERY_CANCELLED");
      await abortableDelay(this.config.pollIntervalMs, signal);
      const value = await this.requestJson(
        `/sites/${encodeURIComponent(this.config.siteId)}/deploys/${encodeURIComponent(deploy.id)}`,
        { method: "GET" },
        "EXPORT_EXTERNAL_NETLIFY_STATUS_FAILED",
        signal,
      );
      deploy = parseDeploy(
        value,
        "EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID",
        this.config.siteId,
      );
    }
  }

  private requestJson(
    path: string,
    init: RequestInit,
    failureCode: string,
    parentSignal?: AbortSignal,
  ) {
    return this.withResponse(path, init, failureCode, parentSignal, async (response) => {
      if (!response.ok) {
        await discardResponseBody(response);
        throw providerResponseError(failureCode, response.status);
      }
      return responseBody(response);
    });
  }

  private requestStatus(
    path: string,
    init: RequestInit,
    failureCode: string,
    parentSignal?: AbortSignal,
  ) {
    return this.withResponse(path, init, failureCode, parentSignal, async (response) => {
      await discardResponseBody(response);
      return { ok: response.ok, status: response.status };
    });
  }

  private async withResponse<T>(
    path: string,
    init: RequestInit,
    failureCode: string,
    parentSignal: AbortSignal | undefined,
    consume: (response: Response) => Promise<T>,
  ) {
    const request = createAbortScope(
      parentSignal,
      this.config.requestTimeoutMs,
      `${failureCode}:TIMEOUT`,
    );
    try {
      let response: Response;
      try {
        throwIfAborted(request.signal, `${failureCode}:ABORTED`);
        response = await this.fetchImplementation(`${this.config.apiBaseUrl}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.config.accessToken}`,
            "User-Agent": "aion-workbench-export-worker/1.0",
            ...init.headers,
          },
          redirect: "error",
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw abortReason(request.signal, `${failureCode}:ABORTED`);
        throw new Error(`${failureCode}:NETWORK`, { cause: error });
      }

      try {
        return await consume(response);
      } catch (error) {
        if (request.signal.aborted) throw abortReason(request.signal, `${failureCode}:ABORTED`);
        throw error;
      }
    } finally {
      request.dispose();
    }
  }
}

function assertNetlifyArchive(request: ExternalExportDeliveryRequest) {
  if (request.payload.packaging !== "zip"
    || request.payload.output.mediaType !== "application/zip"
    || request.bytes.byteLength !== request.payload.output.byteSize
    || createHash("sha256").update(request.bytes).digest("hex") !== request.payload.output.sha256) {
    throw new Error("EXPORT_EXTERNAL_NETLIFY_ARCHIVE_INVALID");
  }
}

function deployTitle(idempotencyKey: string, sha256: string) {
  const identity = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
  return `workbench-${identity}-${sha256.slice(0, 16)}`;
}

function nextDeployTitle(baseTitle: string, existing: readonly NetlifyDeploy[]) {
  const used = new Set(existing.map((deploy) => deploy.title).filter((title): title is string => Boolean(title)));
  if (!used.has(baseTitle)) return baseTitle;
  let retry = 1;
  while (used.has(`${baseTitle}-retry-${retry}`)) retry += 1;
  return `${baseTitle}-retry-${retry}`;
}

function isTerminalDeployState(state: string) {
  return TERMINAL_DEPLOY_STATES.has(state);
}

function netlifyRemoteReference(siteId: string, deploy: NetlifyDeploy) {
  const url = deploy.deploy_ssl_url ?? deploy.deploy_url ?? deploy.ssl_url ?? deploy.url;
  if (!url) throw new Error("EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID");
  const reference = `netlify:${siteId}:${deploy.id}:${encodeURIComponent(url)}`;
  if (reference.length > MAX_REMOTE_REFERENCE_LENGTH) {
    throw new TerminalExportError(
      "EXPORT_EXTERNAL_NETLIFY_REMOTE_REFERENCE_INVALID",
      "Netlify returned a deploy receipt that exceeds the supported length",
    );
  }
  return reference;
}

function parseNetlifyRemoteReference(value: string) {
  if (value.length > MAX_REMOTE_REFERENCE_LENGTH) {
    throw new Error("EXPORT_EXTERNAL_NETLIFY_RECEIPT_INVALID");
  }
  const match = /^netlify:([^:]{1,200}):([^:]{1,200}):(.+)$/u.exec(value);
  if (!match) throw new Error("EXPORT_EXTERNAL_NETLIFY_RECEIPT_INVALID");
  return { siteId: match[1]!, deployId: match[2]! };
}

function parseDeploy(value: unknown, errorCode: string, expectedSiteId: string): NetlifyDeploy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  const record = value as Record<string, unknown>;
  const id = requiredString(record.id, errorCode);
  const siteId = requiredString(record.site_id, errorCode);
  if (siteId !== expectedSiteId) {
    throw new TerminalExportError(
      "EXPORT_EXTERNAL_NETLIFY_RESPONSE_SITE_MISMATCH",
      "Netlify returned a deploy for a different site",
    );
  }
  const state = requiredString(record.state, errorCode);
  return {
    id,
    site_id: siteId,
    state,
    title: optionalString(record.title),
    deploy_ssl_url: optionalString(record.deploy_ssl_url),
    deploy_url: optionalString(record.deploy_url),
    ssl_url: optionalString(record.ssl_url),
    url: optionalString(record.url),
    error_message: optionalString(record.error_message),
  };
}

async function responseBody(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new Error("EXPORT_EXTERNAL_NETLIFY_RESPONSE_INVALID");
  }
}

async function discardResponseBody(response: Response) {
  if (!response.body) return;
  await response.body.cancel();
}

function requiredString(value: unknown, errorCode: string) {
  if (typeof value !== "string" || !value) throw new Error(errorCode);
  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function providerResponseError(code: string, status: number) {
  if (status === 429 || status >= 500) return new Error(`${code}:HTTP_${status}`);
  return new TerminalExportError(code, `Netlify rejected the request with HTTP ${status}`);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal, "EXPORT_ABORTED"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(resolve), milliseconds);
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      complete();
    };
    const abort = () => {
      finish(() => reject(abortReason(signal, "EXPORT_ABORTED")));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function abortablePromise<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal, "EXPORT_ABORTED"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const abort = () => finish(() => reject(abortReason(signal, "EXPORT_ABORTED")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function createAbortScope(parentSignal: AbortSignal | undefined, timeoutMs: number, timeoutCode: string) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;

  const dispose = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (parentSignal && parentListener) {
      parentSignal.removeEventListener("abort", parentListener);
      parentListener = undefined;
    }
  };
  const abort = (reason: Error) => {
    dispose();
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (parentSignal?.aborted) {
    controller.abort(abortReason(parentSignal, "EXPORT_ABORTED"));
  } else {
    if (parentSignal) {
      parentListener = () => abort(abortReason(parentSignal, "EXPORT_ABORTED"));
      parentSignal.addEventListener("abort", parentListener, { once: true });
      if (parentSignal.aborted) parentListener();
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => abort(new Error(timeoutCode)), timeoutMs);
    }
  }

  return { signal: controller.signal, dispose };
}

function throwIfAborted(signal: AbortSignal, fallbackCode: string) {
  if (signal.aborted) throw abortReason(signal, fallbackCode);
}

function abortReason(signal: AbortSignal | undefined, fallbackCode: string) {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallbackCode);
}

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetlifyExternalExportDeliveryAdapter } from "../src/delivery/netlify-external-export-delivery.adapter.js";
import type { ExternalExportDeliveryRequest } from "../src/delivery/external-export-delivery.adapter.js";

const archive = new Uint8Array(Buffer.from("PK\x03\x04deterministic-workbench-archive", "binary"));
const sha256 = createHash("sha256").update(archive).digest("hex");

type ProviderState = {
  createCount: number;
  deleteCount: number;
  statusCount: number;
  requests: Array<{ method: string; path: string; authorization: string | undefined; body: Buffer }>;
  deploy: Record<string, unknown> | null;
};

type ProviderOptions = {
  deploySiteId?: string;
  deployUrl?: string;
  hangCreate?: boolean;
  lookupStatus?: number;
  neverReady?: boolean;
  firstDeployState?: string;
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("NetlifyExternalExportDeliveryAdapter", () => {
  it("publishes a real ZIP wire request, polls readiness, replays idempotently, and revokes", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state);
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const request = deliveryRequest();

    const first = await adapter.deliver(request);
    const replay = await adapter.deliver(request);
    await adapter.revoke({ idempotencyKey: request.idempotencyKey, remoteReference: first.remoteReference });
    await adapter.revoke({ idempotencyKey: request.idempotencyKey, remoteReference: first.remoteReference });

    expect(first).toEqual(replay);
    expect(first.remoteReference).toMatch(/^netlify:site-123:deploy-1:/u);
    expect(state.createCount).toBe(1);
    expect(state.deleteCount).toBe(2);
    const create = state.requests.find((entry) => entry.method === "POST");
    expect(create?.authorization).toBe("Bearer provider-token");
    expect(create?.path).toMatch(/^\/api\/v1\/sites\/site-123\/deploys\?title=workbench-/u);
    expect(create?.body).toEqual(Buffer.from(archive));
  });

  it("starts a fresh deploy after a provider terminal failure", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { firstDeployState: "failed" });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const request = deliveryRequest();

    await expect(adapter.deliver(request)).rejects.toThrow("EXPORT_EXTERNAL_NETLIFY_DEPLOY_FAILED");
    const retried = await adapter.deliver(request);
    const createPaths = state.requests
      .filter((entry) => entry.method === "POST")
      .map((entry) => entry.path);

    expect(retried.remoteReference).toMatch(/^netlify:site-123:deploy-1:/u);
    expect(state.createCount).toBe(2);
    expect(createPaths).toHaveLength(2);
    expect(createPaths[1]).not.toBe(createPaths[0]);
    expect(createPaths[1]).toContain("-retry-1");
  });

  it("stops polling promptly when the delivery is cancelled", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { neverReady: true });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    let checks = 0;

    await expect(adapter.deliver(deliveryRequest({
      isCancelled: async () => {
        checks += 1;
        return checks >= 2;
      },
    }))).rejects.toThrow("EXPORT_DELIVERY_CANCELLED");
    expect(state.createCount).toBe(1);
  });

  it("bounds the complete deploy operation when Netlify never becomes ready", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { neverReady: true });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 200,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest()))
      .rejects.toThrow("EXPORT_EXTERNAL_NETLIFY_OPERATION_TIMEOUT");
    expect(state.statusCount).toBeGreaterThan(0);
    const completedStatusCount = state.statusCount;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(state.statusCount).toBe(completedStatusCount);
  });

  it("returns a stable timeout code when a provider request hangs", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { hangCreate: true });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 200,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest()))
      .rejects.toThrow("EXPORT_EXTERNAL_NETLIFY_OPERATION_TIMEOUT");
    expect(state.createCount).toBe(1);
  });

  it("rejects deploy responses that belong to a different configured site", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { deploySiteId: "site-other" });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest())).rejects.toMatchObject({
      name: "TerminalExportError",
      code: "EXPORT_EXTERNAL_NETLIFY_RESPONSE_SITE_MISMATCH",
    });
  });

  it("treats non-throttling 4xx responses as terminal with a stable failure code", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, { lookupStatus: 401 });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest())).rejects.toMatchObject({
      name: "TerminalExportError",
      code: "EXPORT_EXTERNAL_NETLIFY_LOOKUP_FAILED",
      safeDetail: "Netlify rejected the request with HTTP 401",
    });
  });

  it.each([429, 500, 503])("keeps HTTP %i retryable without losing the operation code", async (status) => {
    const state = providerState();
    const baseUrl = await startProvider(state, { lookupStatus: status });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest())).rejects.toMatchObject({
      name: "Error",
      message: `EXPORT_EXTERNAL_NETLIFY_LOOKUP_FAILED:HTTP_${status}`,
    });
  });

  it("rejects a provider receipt that cannot fit the durable remote reference", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state, {
      deployUrl: `https://${"a".repeat(520)}.netlify.app`,
    });
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    await expect(adapter.deliver(deliveryRequest())).rejects.toMatchObject({
      name: "TerminalExportError",
      code: "EXPORT_EXTERNAL_NETLIFY_REMOTE_REFERENCE_INVALID",
    });
  });

  it("removes the caller abort listener after a successful operation", async () => {
    const state = providerState();
    const baseUrl = await startProvider(state);
    const adapter = new NetlifyExternalExportDeliveryAdapter({
      apiBaseUrl: `${baseUrl}/api/v1`,
      siteId: "site-123",
      accessToken: "provider-token",
      requestTimeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");

    await adapter.deliver(deliveryRequest({ signal: controller.signal }));

    expect(added.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
    expect(removed.mock.calls.filter(([type]) => type === "abort")).toHaveLength(1);
  });
});

function deliveryRequest(overrides: Partial<ExternalExportDeliveryRequest> = {}): ExternalExportDeliveryRequest {
  return {
    deliveryId: "delivery-123",
    idempotencyKey: "delivery-123",
    target: "netlify",
    payload: {
      exportJobId: "export-123",
      releaseId: "release-123",
      format: "html",
      packaging: "zip",
      selection: { kind: "release" },
      output: {
        mediaType: "application/zip",
        byteSize: archive.byteLength,
        sha256,
        fileName: "workbench.zip",
      },
    },
    bytes: archive,
    isCancelled: async () => false,
    ...overrides,
  };
}

function providerState(): ProviderState {
  return { createCount: 0, deleteCount: 0, statusCount: 0, requests: [], deploy: null };
}

async function startProvider(
  state: ProviderState,
  options: ProviderOptions = {},
) {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = request.url ?? "/";
    state.requests.push({
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization,
      body,
    });
    if (request.headers.authorization !== "Bearer provider-token") {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && /^\/api\/v1\/sites\/site-123\/deploys\?/u.test(path)) {
      if (options.lookupStatus !== undefined) {
        json(response, options.lookupStatus, { error: "configured lookup failure" });
        return;
      }
      json(response, 200, state.deploy ? [state.deploy] : []);
      return;
    }
    if (request.method === "POST" && /^\/api\/v1\/sites\/site-123\/deploys\?title=/u.test(path)) {
      state.createCount += 1;
      if (options.hangCreate) return;
      const title = decodeURIComponent(path.split("title=")[1] ?? "");
      state.deploy = deploy(
        title,
        state.createCount === 1 && options.firstDeployState
          ? options.firstDeployState
          : options.neverReady ? "processing" : "uploading",
        options.deploySiteId,
        options.deployUrl,
      );
      json(response, 200, state.deploy);
      return;
    }
    if (request.method === "GET" && path === "/api/v1/sites/site-123/deploys/deploy-1") {
      state.statusCount += 1;
      state.deploy = { ...state.deploy, state: options.neverReady ? "processing" : "ready" };
      json(response, 200, state.deploy);
      return;
    }
    if (request.method === "DELETE" && path === "/api/v1/sites/site-123/deploys/deploy-1") {
      state.deleteCount += 1;
      if (state.deleteCount === 1) state.deploy = null;
      else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(204).end();
      return;
    }
    json(response, 404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("provider server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function deploy(
  title: string,
  state: string,
  siteId = "site-123",
  deployUrl = "https://deploy-1--site-123.netlify.app",
) {
  return {
    id: "deploy-1",
    site_id: siteId,
    state,
    title,
    deploy_ssl_url: deployUrl,
  };
}

function readBody(request: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

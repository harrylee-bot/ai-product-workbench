import { createServer, type ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { prismaReadyObjectIntegrityRecorder } from "@workbench/workbench-content-security";
import { loadPreviewConfig } from "./config.js";
import { createPreviewDb } from "./db.js";
import { PreviewService } from "./preview.service.js";
import { preparePreviewResponse } from "./preview-request.js";
import { hasAmbientCredentials } from "./request-security.js";
import { PreviewStorage } from "./storage.js";

async function main() {
  const config = loadPreviewConfig();
  const db = createPreviewDb(config);
  await db.$connect();
  const service = new PreviewService(
    db,
    new PreviewStorage(config, prismaReadyObjectIntegrityRecorder(db)),
    config,
  );
  let active = 0;

  const server = createServer(async (request, response) => {
    applyBaseHeaders(response);
    if (request.url === "/healthz" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("ok\n");
      return;
    }
    if ((request.method !== "GET" && request.method !== "HEAD") || !request.url?.startsWith("/preview/")) {
      notFound(response);
      return;
    }
    if (hasAmbientCredentials(request.headers)) {
      notFound(response);
      return;
    }
    if (active >= config.maximumConcurrency) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "1" });
      response.end("Preview temporarily unavailable\n");
      return;
    }
    const token = request.url.slice("/preview/".length);
    if (!token || token.includes("/") || token.includes("?") || token.includes("#")) {
      notFound(response);
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("PREVIEW_CLIENT_DISCONNECTED"));
    request.once("aborted", abort);
    response.once("close", abort);
    active += 1;
    try {
      const prepared = await preparePreviewResponse(service, {
        token,
        method: request.method,
        ifNoneMatch: request.headers["if-none-match"],
      }, controller.signal);
      if (prepared.status === 304) {
        response.writeHead(304, previewHeaders(prepared));
        response.end();
        return;
      }
      if (prepared.head) {
        response.writeHead(200, {
          ...previewHeaders(prepared),
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": "inline",
        });
        response.end();
        return;
      }
      const preview = prepared.preview;
      try {
        response.writeHead(200, {
          ...previewHeaders(preview),
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(preview.byteSize),
          "Content-Disposition": "inline",
        });
        await pipeline(preview.body, response, { signal: controller.signal });
      } finally {
        await preview.dispose();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[preview] request rejected", publicDiagnostic(error));
        notFound(response);
      }
    } finally {
      active -= 1;
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  console.log(`[preview] listening on ${config.host}:${config.port} for ${config.publicOrigin}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[preview] received ${signal}`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$disconnect();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
}

function previewHeaders(preview: { etag: string; contentSecurityPolicy?: string }) {
  return {
    ETag: preview.etag,
    "Cache-Control": "private, no-store, max-age=0",
    ...(preview.contentSecurityPolicy
      ? { "Content-Security-Policy": preview.contentSecurityPolicy }
      : {}),
  };
}

function applyBaseHeaders(response: ServerResponse) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  response.setHeader("Origin-Agent-Cluster", "?1");
}

function notFound(response: ServerResponse) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end("Preview not found\n");
}

function publicDiagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

void main().catch((error) => {
  console.error("[preview] fatal", error);
  process.exit(1);
});

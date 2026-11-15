import { createServer, type Server } from "node:http";

export function createTemporalWorkerHealthServer(
  port: number,
  isReady: () => boolean,
  onStart?: (payload: Record<string, unknown>) => Promise<void>,
  onCancel?: (payload: Record<string, unknown>) => Promise<void>,
  onExecute?: (payload: Record<string, unknown>) => Promise<unknown>,
): Server {
  return createServer((request, response) => {
    if (request.url === "/healthz") {
      response.statusCode = isReady() ? 200 : 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: isReady() ? "ready" : "starting" }));
      return;
    }
    if (request.method !== "POST" || (request.url !== "/workflows/start" && request.url !== "/workflows/cancel" && request.url !== "/workflows/execute")) { response.statusCode = 404; response.end(); return; }
    if (!isReady()) { response.statusCode = 503; response.end(JSON.stringify({ code: "TEMPORAL_WORKER_NOT_READY" })); return; }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        let result: unknown;
        if (request.url === "/workflows/start") await onStart?.(payload);
        else if (request.url === "/workflows/cancel") await onCancel?.(payload);
        else result = await onExecute?.(payload);
        response.statusCode = request.url === "/workflows/execute" ? 200 : 202;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.url === "/workflows/execute" ? result : { accepted: true }));
      })().catch((error) => { response.statusCode = 500; response.end(JSON.stringify({ code: "TEMPORAL_WORKFLOW_FAILED", detail: error instanceof Error ? error.message : "workflow failed" })); });
    });
  }).listen(port, "0.0.0.0");
}

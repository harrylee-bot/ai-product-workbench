import { traceHttpServerRequest, tracedFetch } from "@workbench/workbench-telemetry";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const SUPPORTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "cache-control",
  "content-type",
  "idempotency-key",
  "if-match",
  "if-none-match",
  "last-event-id",
  "range",
  "traceparent",
  "tracestate",
]);
const RESPONSE_HEADER_BLOCKLIST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type WorkbenchBffOptions = {
  upstreamBaseUrl: string;
  expectedOrigin: string;
  getBearerToken: (headers: Headers) => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  maximumRequestBytes?: number;
};

export function createWorkbenchBffHandler({
  upstreamBaseUrl,
  expectedOrigin,
  getBearerToken,
  fetch: fetchImplementation = globalThis.fetch,
  maximumRequestBytes = 2 * 1024 * 1024,
}: WorkbenchBffOptions) {
  const upstream = normalizeUpstreamBaseUrl(upstreamBaseUrl);
  const allowedOrigin = new URL(expectedOrigin).origin;
  if (!Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes < 1) {
    throw new Error("maximumRequestBytes must be a positive safe integer");
  }

  return (request: Request, pathSegments: readonly string[]): Promise<Response> => traceHttpServerRequest({
    method: request.method,
    route: "/api/v1/*",
    headers: request.headers,
  }, async () => {
    const method = request.method.toUpperCase();
    if (!SUPPORTED_METHODS.has(method)) {
      return problem(405, "请求方法不受支持", `产品工作台不支持 ${method} 请求`);
    }
    if (isManagementProbe(pathSegments)) {
      return problem(404, "未找到", "产品工作台未公开该管理端点");
    }
    if (!SAFE_METHODS.has(method) && !hasExpectedOrigin(request.headers, allowedOrigin)) {
      return problem(403, "禁止访问", "请求来源不被产品工作台允许");
    }

    const contentLength = parseContentLength(request.headers.get("content-length"));
    if (contentLength !== null && contentLength > maximumRequestBytes) {
      return problem(413, "请求内容过大", "请求内容超过产品工作台限制");
    }

    let body: ArrayBuffer | undefined;
    if (!SAFE_METHODS.has(method)) {
      body = await request.arrayBuffer();
      if (body.byteLength > maximumRequestBytes) {
        return problem(413, "请求内容过大", "请求内容超过产品工作台限制");
      }
    }

    let bearerToken: string | null;
    try {
      bearerToken = await getBearerToken(request.headers);
    } catch {
      return problem(503, "登录服务暂不可用", "产品工作台登录服务暂不可用");
    }
    const headers = forwardedRequestHeaders(request.headers);
    if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);

    const target = buildTargetUrl(upstream, request.url, pathSegments);
    let response: Response;
    try {
      response = await tracedFetch(target, {
        method,
        headers,
        body,
        cache: "no-store",
        redirect: "manual",
        signal: request.signal,
      }, fetchImplementation);
    } catch (error) {
      if (request.signal.aborted) throw error;
      return problem(502, "产品工作台服务暂不可用", "产品工作台服务暂不可用");
    }

    const responseHeaders = forwardedResponseHeaders(response.headers);
    if (bearerToken && !responseHeaders.has("cache-control")) {
      responseHeaders.set("Cache-Control", "private, no-store");
    }
    return new Response(method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }, (response) => response.status);
}

function isManagementProbe(pathSegments: readonly string[]): boolean {
  return pathSegments.length === 2
    && pathSegments[0] === "system"
    && (pathSegments[1] === "live" || pathSegments[1] === "ready");
}

function normalizeUpstreamBaseUrl(value: string): URL {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("WORKBENCH_API_INTERNAL_URL must be an http(s) URL without credentials, query, or fragment");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function buildTargetUrl(baseUrl: URL, requestUrl: string, pathSegments: readonly string[]): URL {
  const target = new URL(baseUrl);
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  target.pathname = `${baseUrl.pathname}${encodedPath}`;
  target.search = new URL(requestUrl).search;
  return target;
}

function hasExpectedOrigin(headers: Headers, expectedOrigin: string): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function forwardedRequestHeaders(input: Headers): Headers {
  const output = new Headers();
  let acceptedTraceparent = false;
  for (const [name, value] of input) {
    const normalizedName = name.toLowerCase();
    if (!REQUEST_HEADER_ALLOWLIST.has(normalizedName)) continue;
    if (normalizedName === "traceparent") {
      if (!validTraceparent(value)) continue;
      acceptedTraceparent = true;
    }
    if (normalizedName === "tracestate" && (!acceptedTraceparent || !validTraceMetadata(value, 512))) continue;
    output.set(name, value);
  }
  if (!acceptedTraceparent) output.delete("tracestate");
  return output;
}

function validTraceparent(value: string): boolean {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(value);
  return Boolean(
    match
    && match[1] !== "ff"
    && match[2] !== "0".repeat(32)
    && match[3] !== "0".repeat(16),
  );
}

function validTraceMetadata(value: string, maximumLength: number): boolean {
  return value.length > 0
    && value.length <= maximumLength
    && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function forwardedResponseHeaders(input: Headers): Headers {
  const output = new Headers();
  for (const [name, value] of input) {
    if (!RESPONSE_HEADER_BLOCKLIST.has(name.toLowerCase())) output.append(name, value);
  }
  return output;
}

function problem(status: number, title: string, detail: string): Response {
  return Response.json(
    {
      type: "about:blank",
      title,
      status,
      detail,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json",
      },
    },
  );
}

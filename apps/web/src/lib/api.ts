import { clearSession, readSession } from "./auth-storage";

const API_BASE_URL_ENV = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

function getApiBaseUrl() {
  if (API_BASE_URL_ENV) {
    return API_BASE_URL_ENV;
  }

  if (typeof window === "undefined") {
    return "http://localhost:4000/api";
  }

  return `${window.location.protocol}//${window.location.hostname}:4000/api`;
}

const API_BASE_URL = getApiBaseUrl();

type ApiOptions = RequestInit & {
  skipAuth?: boolean;
  tokenOverride?: string;
};

type ApiHealthResponse = {
  ok: boolean;
  service: string;
  modules?: string[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const session = readSession();
  const token = options.tokenOverride ?? session?.accessToken;
  const headers = new Headers(options.headers);

  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!options.skipAuth && token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  } catch {
    throw new ApiError("无法连接 API 服务，请确认后端已启动并可访问", 503);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof payload?.message === "string" ? payload.message : "请求失败，请稍后重试";

    if ((response.status === 401 || message.includes("禁用")) && typeof window !== "undefined") {
      clearSession();
      window.dispatchEvent(
        new CustomEvent("auth:expired", {
          detail: { message },
        }),
      );
    }

    throw new ApiError(message, response.status);
  }

  return payload as T;
}

export async function streamApiEvents<T>(
  path: string,
  onEvent: (event: T, meta: { type?: string }) => void,
  options: { signal?: AbortSignal } = {},
) {
  const session = readSession();
  const headers = new Headers();

  if (session?.accessToken) {
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw new ApiError("无法连接 API 服务，请确认后端已启动并可访问", 503);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      typeof payload?.message === "string" ? payload.message : "流式连接失败，请稍后重试";

    if ((response.status === 401 || message.includes("禁用")) && typeof window !== "undefined") {
      clearSession();
      window.dispatchEvent(
        new CustomEvent("auth:expired", {
          detail: { message },
        }),
      );
    }

    throw new ApiError(message, response.status);
  }

  if (!response.body) {
    throw new ApiError("当前浏览器不支持流式响应", 500);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      parts.forEach((part) => parseSseBlock(part, onEvent));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    throw new ApiError("流式连接中断，正在尝试恢复执行进度", 503);
  }

  if (buffer.trim()) {
    parseSseBlock(buffer, onEvent);
  }
}

export async function downloadApiFile(path: string) {
  const session = readSession();
  const headers = new Headers();

  if (session?.accessToken) {
    headers.set("Authorization", `Bearer ${session.accessToken}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { headers });
  } catch {
    throw new ApiError("无法连接 API 服务，请确认后端已启动并可访问", 503);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      typeof payload?.message === "string" ? payload.message : "文件导出失败，请稍后重试";

    if ((response.status === 401 || message.includes("禁用")) && typeof window !== "undefined") {
      clearSession();
      window.dispatchEvent(
        new CustomEvent("auth:expired", {
          detail: { message },
        }),
      );
    }

    throw new ApiError(message, response.status);
  }

  const blob = await response.blob();
  const fileName = fileNameFromDisposition(response.headers.get("Content-Disposition")) ?? "export";
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function parseSseBlock<T>(
  block: string,
  onEvent: (event: T, meta: { type?: string }) => void,
) {
  let type: string | undefined;
  const dataLines: string[] = [];

  block.split(/\r?\n/).forEach((line) => {
    if (line.startsWith("event:")) {
      type = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  if (!dataLines.length) return;
  const rawData = dataLines.join("\n");

  try {
    onEvent(JSON.parse(rawData) as T, { type });
  } catch {
    onEvent(rawData as T, { type });
  }
}

export function toQueryString(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function fileNameFromDisposition(value: string | null) {
  if (!value) return null;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  const fallback = value.match(/filename="([^"]+)"/i)?.[1];
  return fallback ?? null;
}

export async function assertWorkbenchApiAvailable() {
  const response = await apiRequest<ApiHealthResponse>("/system/health", { skipAuth: true });
  const modules = new Set(response.modules ?? []);
  if (
    !response.ok ||
    response.service !== "ai-product-workbench-api" ||
    !modules.has("projects")
  ) {
    throw new ApiError("API 服务未启动或端口被旧服务占用，请重启后端服务", 503);
  }
}

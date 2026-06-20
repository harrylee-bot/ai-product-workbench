import { clearSession, readSession } from "./auth-storage";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api";

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

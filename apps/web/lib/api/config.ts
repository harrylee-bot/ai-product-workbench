// NestJS 后端 API 基址。单一来源，供前端所有 REST/SWR 调用复用。

export function getApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  // 浏览器侧默认指向同主机后端端口；服务端侧默认 localhost
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:4000/api`;
  }
  return "http://localhost:4000/api";
}

export const API_BASE = getApiBase();

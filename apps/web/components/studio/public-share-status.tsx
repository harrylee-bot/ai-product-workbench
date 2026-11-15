"use client";
import { isWorkbenchApiError } from "@/lib/workbench/api";

export function PublicShareStatus({
  error,
  unavailablePreview = false,
  onRetry,
}: {
  error?: unknown;
  unavailablePreview?: boolean;
  onRetry: () => void;
}) {
  const apiError = isWorkbenchApiError(error) ? error : null;
  const preview =
    unavailablePreview ||
    [
      "SHARE_PREVIEW_UNAVAILABLE",
      "PROTOTYPE_PREVIEW_INTEGRITY_FAILURE",
      "PROTOTYPE_PREVIEW_NOT_FROZEN",
    ].includes(apiError?.code ?? "");
  const state = preview
    ? "preview"
    : apiError?.code === "SHARE_REVOKED"
      ? "revoked"
      : apiError?.code === "SHARE_EXPIRED"
        ? "expired"
        : [404, 410].includes(apiError?.status ?? 0) || !error
          ? "invalid"
          : [401, 403].includes(apiError?.status ?? 0)
            ? "denied"
            : "loading-failed";
  const messages = {
    invalid: ["分享链接无效", "请核对完整链接，或联系分享者获取新链接。"],
    expired: ["分享已过期", "此链接已超过有效期，请联系分享者获取新链接。"],
    revoked: ["分享已撤销", "分享者已关闭此链接，原内容不再通过本链接提供。"],
    preview: ["暂无可用预览", "此分享的预览暂不可用，请稍后重试或联系分享者。"],
    denied: ["无法访问此分享", "当前请求没有访问此分享的权限。"],
    "loading-failed": ["分享加载失败", "分享服务暂不可用，请稍后重试"],
  } as const;
  return (
    <main className="studio-loading" role="alert">
      <h1>{messages[state][0]}</h1>
      <p>{messages[state][1]}</p>
      {["preview", "loading-failed", "denied"].includes(state) && (
        <button onClick={onRetry}>重试</button>
      )}
    </main>
  );
}

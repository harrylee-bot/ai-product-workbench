"use client";

import type { ProjectRole } from "@workbench/workbench-contracts";
import {
  ArrowRightIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { isWorkbenchApiError } from "@/lib/workbench/api/problem-details";
import {
  useAcceptWorkbenchProjectInvitation,
  useWorkbenchProjectInvitationPreview,
  projectInvitationTokenFromHash,
  projectInvitationTokenStorageKey,
} from "@/lib/workbench/features/projects";

const roleLabels: Record<ProjectRole, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "查看者",
};

export default function ProjectInvitationAcceptPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const preview = useWorkbenchProjectInvitationPreview(token ?? "");
  const accept = useAcceptWorkbenchProjectInvitation();
  const [acceptedProjectId, setAcceptedProjectId] = useState<string | null>(null);

  useEffect(() => {
    const hadFragment = Boolean(window.location.hash);
    const fragmentToken = projectInvitationTokenFromHash(window.location.hash);
    let storedToken: string | null = null;
    try {
      if (fragmentToken) {
        window.sessionStorage.setItem(projectInvitationTokenStorageKey, fragmentToken);
      } else if (hadFragment) {
        window.sessionStorage.removeItem(projectInvitationTokenStorageKey);
      }
      storedToken = window.sessionStorage.getItem(projectInvitationTokenStorageKey);
    } catch {
      storedToken = null;
    }
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
    setToken(hadFragment
      ? fragmentToken
      : projectInvitationTokenFromHash(`#token=${storedToken ?? ""}`));
  }, []);

  const acceptInvitation = async () => {
    if (!token) return;
    try {
      const result = await accept.mutateAsync(token);
      setAcceptedProjectId(result.value.invitation.projectId);
      try {
        window.sessionStorage.removeItem(projectInvitationTokenStorageKey);
      } catch {
        // Storage is optional once the server has accepted the invitation.
      }
    } catch {
      // The mutation error is rendered below with its contract-aware message.
    }
  };

  const projectId = acceptedProjectId
    ?? (preview.data?.status === "accepted" ? preview.data.projectId : null);

  return (
    <main className="grid min-h-screen place-items-center px-[16px] py-[28px]">
      <section className="w-full max-w-[460px] overflow-hidden rounded-[8px] border border-white/[0.10] bg-[#18191b] shadow-[0_22px_70px_rgba(0,0,0,0.36)]" aria-labelledby="invitation-title">
        <header className="border-b border-white/[0.08] px-[22px] py-[20px]">
          <div className="flex items-center gap-[9px] text-[12px] font-semibold text-[#b8b0ff]">
            <ShieldCheckIcon className="size-[16px]" />
            产品工作台
          </div>
          <h1 className="mt-[10px] text-[18px] font-semibold" id="invitation-title">接受项目邀请</h1>
        </header>

        <div className="px-[22px] py-[20px]">
          {token === undefined ? (
            <div className="flex items-center gap-[8px] text-[12px] text-[#aeb3bb]" role="status">
              <LoaderCircleIcon className="size-[15px] animate-spin" />
              正在读取邀请...
            </div>
          ) : token === null ? (
            <InvitationMessage tone="error">邀请链接无效或不完整。</InvitationMessage>
          ) : preview.isPending ? (
            <div className="flex items-center gap-[8px] text-[12px] text-[#aeb3bb]" role="status">
              <LoaderCircleIcon className="size-[15px] animate-spin" />
              正在验证邀请...
            </div>
          ) : preview.error ? (
            <div>
              <InvitationMessage tone="error">{invitationError(preview.error)}</InvitationMessage>
              <button
                className="mt-[12px] inline-flex h-[32px] items-center gap-[6px] rounded-[8px] border border-white/[0.12] px-[10px] text-[11px] font-semibold hover:bg-white/[0.06]"
                onClick={() => void preview.refetch()}
                type="button"
              >
                <RefreshCwIcon className="size-[13px]" />
                重试
              </button>
            </div>
          ) : preview.data ? (
            <div>
              <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-[12px] gap-y-[10px] text-[12px]">
                <dt className="text-[#8f949c]">项目</dt>
                <dd className="min-w-0 truncate font-semibold text-[#f1f3f4]">{preview.data.projectTitle}</dd>
                <dt className="text-[#8f949c]">工作区</dt>
                <dd className="min-w-0 truncate text-[#d8dce2]">{preview.data.workspaceName}</dd>
                <dt className="text-[#8f949c]">受邀邮箱</dt>
                <dd className="min-w-0 break-all text-[#d8dce2]">{preview.data.email}</dd>
                <dt className="text-[#8f949c]">项目角色</dt>
                <dd className="text-[#d8dce2]">{roleLabels[preview.data.role]}</dd>
                <dt className="text-[#8f949c]">有效期至</dt>
                <dd className="text-[#d8dce2]">{formatDate(preview.data.expiresAt)}</dd>
              </dl>

              {preview.data.status !== "pending" && preview.data.status !== "accepted" && (
                <div className="mt-[16px]">
                  <InvitationMessage tone="error">
                    {preview.data.status === "expired" ? "邀请已过期。" : "邀请已被撤销。"}
                  </InvitationMessage>
                </div>
              )}
              {acceptedProjectId && (
                <div className="mt-[16px]">
                  <InvitationMessage tone="success">邀请已接受，项目权限已生效。</InvitationMessage>
                </div>
              )}
              {accept.error && (
                <div className="mt-[16px]">
                  <InvitationMessage tone="error">{invitationError(accept.error)}</InvitationMessage>
                </div>
              )}
            </div>
          ) : null}
        </div>

        <footer className="flex min-h-[60px] items-center justify-end border-t border-white/[0.08] px-[22px] py-[12px]">
          {projectId ? (
            <button
              className="inline-flex h-[36px] items-center gap-[7px] rounded-[8px] bg-[#e8eaed] px-[13px] text-[12px] font-semibold text-[#202124] hover:bg-white"
              onClick={() => window.location.assign(`/projects/${projectId}`)}
              type="button"
            >
              进入项目
              <ArrowRightIcon className="size-[14px]" />
            </button>
          ) : (
            <button
              className="inline-flex h-[36px] items-center gap-[7px] rounded-[8px] bg-[#e8eaed] px-[13px] text-[12px] font-semibold text-[#202124] hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
              disabled={preview.data?.status !== "pending" || accept.isPending}
              onClick={() => void acceptInvitation()}
              type="button"
            >
              {accept.isPending && <LoaderCircleIcon className="size-[14px] animate-spin" />}
              接受邀请
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}

function InvitationMessage({ children, tone }: { children: React.ReactNode; tone: "error" | "success" }) {
  return (
    <div
      className={tone === "success"
        ? "rounded-[8px] border border-[#65a875]/35 bg-[#214b2a]/18 px-[11px] py-[9px] text-[12px] leading-[17px] text-[#a9d9b3]"
        : "rounded-[8px] border border-[#d96868]/35 bg-[#6e2525]/18 px-[11px] py-[9px] text-[12px] leading-[17px] text-[#f0aaaa]"}
      role={tone === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

function invitationError(error: unknown) {
  if (isWorkbenchApiError(error)) {
    if (error.status === 409) return error.message;
    if (error.status === 404) return "邀请不存在、已失效或项目已归档。";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "邀请操作失败，请重试。";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

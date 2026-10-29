"use client";

import type {
  ProjectMember,
  ProjectInvitationListItem,
  ProjectRole,
  WorkspaceMember,
} from "@workbench/workbench-contracts";
import { projectInvitationEmailSchema } from "@workbench/workbench-contracts";
import {
  CopyIcon,
  MailPlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isWorkbenchApiError } from "@/lib/workbench/api/problem-details";
import {
  useRemoveWorkbenchProjectMember,
  useCreateWorkbenchProjectInvitation,
  useInfiniteWorkbenchProjectInvitations,
  useInfiniteWorkbenchWorkspaceMembers,
  useRevokeWorkbenchProjectInvitation,
  useSetWorkbenchProjectMemberRole,
  useWorkbenchProjectMembers,
  projectInvitationAcceptUrl,
} from "@/lib/workbench/features/projects";
import { cn } from "@/lib/utils";

const roleLabels: Record<ProjectRole, string> = {
  owner: "所有者",
  editor: "编辑者",
  viewer: "查看者",
};

const roleOptions: ProjectRole[] = ["owner", "editor", "viewer"];

export function WorkbenchProjectMembersDialog({
  canManageMembers,
  onOpenChange,
  open,
  projectId,
  projectTitle,
  workspaceId,
}: {
  canManageMembers: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projectId: string;
  projectTitle: string;
  workspaceId: string;
}) {
  const membersQuery = useWorkbenchProjectMembers(projectId);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const workspaceMembersQuery = useInfiniteWorkbenchWorkspaceMembers(
    workspaceId,
    deferredSearch.trim() ? { q: deferredSearch.trim(), limit: 30 } : { limit: 30 },
  );
  const setRole = useSetWorkbenchProjectMemberRole(projectId);
  const removeMember = useRemoveWorkbenchProjectMember(projectId);
  const invitationsQuery = useInfiniteWorkbenchProjectInvitations(
    canManageMembers ? projectId : "",
    { status: "pending", limit: 30 },
  );
  const createInvitation = useCreateWorkbenchProjectInvitation(projectId);
  const revokeInvitation = useRevokeWorkbenchProjectInvitation(projectId);
  const [addRole, setAddRole] = useState<ProjectRole>("editor");
  const [inviteEmail, setInviteEmail] = useState("");
  const [createdInvitationId, setCreatedInvitationId] = useState<string | null>(null);
  const [copiedInvitationId, setCopiedInvitationId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const members = membersQuery.data?.items ?? [];
  const memberIds = useMemo(() => new Set(members.map((member) => member.principalId)), [members]);
  const workspaceCandidates = (workspaceMembersQuery.data?.pages.flatMap((page) => page.items) ?? [])
    .filter((member) => !memberIds.has(member.principalId));
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const invitations = invitationsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const normalizedInviteEmail = projectInvitationEmailSchema.safeParse(inviteEmail);
  const mutationBusy = setRole.isPending
    || removeMember.isPending
    || createInvitation.isPending
    || revokeInvitation.isPending;

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setAddRole("editor");
    setInviteEmail("");
    setCreatedInvitationId(null);
    setCopiedInvitationId(null);
    setOperationError(null);
  }, [open, projectId]);

  const runRoleChange = async (member: ProjectMember, role: ProjectRole) => {
    if (!canManageMembers || member.role === role) return;
    setOperationError(null);
    try {
      await setRole.mutateAsync({
        principalId: member.principalId,
        request: { role },
      });
    } catch (error) {
      setOperationError(memberOperationError(error));
    }
  };

  const addMember = async (member: WorkspaceMember) => {
    if (!canManageMembers || memberIds.has(member.principalId)) return;
    setOperationError(null);
    try {
      await setRole.mutateAsync({
        principalId: member.principalId,
        request: { role: addRole },
      });
      setSearch("");
    } catch (error) {
      setOperationError(memberOperationError(error));
    }
  };

  const remove = async (member: ProjectMember) => {
    if (!canManageMembers || (member.role === "owner" && ownerCount <= 1)) return;
    setOperationError(null);
    try {
      await removeMember.mutateAsync({ principalId: member.principalId });
    } catch (error) {
      setOperationError(memberOperationError(error));
    }
  };

  const invite = async () => {
    if (!canManageMembers || !normalizedInviteEmail.success) return;
    setOperationError(null);
    setCreatedInvitationId(null);
    try {
      const result = await createInvitation.mutateAsync({
        request: { email: normalizedInviteEmail.data, role: addRole },
      });
      setInviteEmail("");
      setCreatedInvitationId(result.value.invitation.id);
    } catch (error) {
      setOperationError(memberOperationError(error));
    }
  };

  const copyInvitation = async (item: ProjectInvitationListItem) => {
    if (!item.token) return;
    setOperationError(null);
    try {
      await navigator.clipboard.writeText(
        projectInvitationAcceptUrl(item.token, window.location.origin),
      );
      setCopiedInvitationId(item.invitation.id);
    } catch {
      setOperationError("无法复制邀请链接，请检查浏览器剪贴板权限");
    }
  };

  const revoke = async (item: ProjectInvitationListItem) => {
    if (!canManageMembers) return;
    setOperationError(null);
    try {
      await revokeInvitation.mutateAsync({ invitationId: item.invitation.id });
      setCreatedInvitationId((current) => current === item.invitation.id ? null : current);
      setCopiedInvitationId((current) => current === item.invitation.id ? null : current);
    } catch (error) {
      setOperationError(memberOperationError(error));
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="grid max-h-[min(760px,calc(100vh-32px))] w-[min(700px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-white/[0.10] bg-[#18191b]/98 p-0 text-[#f1f3f4]"
        data-project-members-dialog
      >
        <DialogHeader className="border-b border-white/[0.08] px-[22px] py-[18px] pr-[60px]">
          <DialogTitle className="flex items-center gap-[9px] text-[16px]">
            <UsersIcon className="size-[17px] text-[#b8b0ff]" />
            成员与权限
          </DialogTitle>
          <DialogDescription className="mt-[6px] text-[13px] text-[#9da2aa]">
            {projectTitle} · 当前项目成员
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto px-[18px] py-[14px]">
          {operationError && (
            <div className="mb-[12px] flex items-start justify-between gap-[10px] rounded-[10px] border border-[#d96868]/35 bg-[#6e2525]/18 px-[11px] py-[9px] text-[13px] leading-[17px] text-[#f0aaaa]" role="alert">
              <span>{operationError}</span>
              <button
                aria-label="刷新成员列表"
                className="grid size-[24px] shrink-0 place-items-center rounded-full hover:bg-white/[0.08]"
                onClick={() => {
                  setOperationError(null);
                  void membersQuery.refetch();
                }}
                type="button"
              >
                <RefreshCwIcon className="size-[14px]" />
              </button>
            </div>
          )}

          <section aria-label="项目成员">
            <div className="mb-[8px] flex items-center justify-between text-[13px] font-semibold text-[#aeb3bb]">
              <span>项目成员</span>
              <span>{members.length} 人</span>
            </div>
            <MemberList
              canManageMembers={canManageMembers}
              error={membersQuery.error}
              loading={membersQuery.isPending}
              members={members}
              mutationBusy={mutationBusy}
              onRemove={remove}
              onRetry={() => void membersQuery.refetch()}
              onRoleChange={runRoleChange}
              ownerCount={ownerCount}
            />
          </section>

          {canManageMembers && (
            <section className="mt-[18px] border-t border-white/[0.08] pt-[16px]" aria-label="添加或邀请成员">
              <div className="mb-[8px] flex items-center gap-[7px] text-[13px] font-semibold text-[#aeb3bb]">
                <UserPlusIcon className="size-[14px]" />
                添加或邀请成员
              </div>
              <div className="flex flex-wrap gap-[8px]">
                <input
                  aria-label="搜索工作区成员"
                  className="h-[34px] min-w-[220px] flex-1 rounded-[8px] border border-white/[0.10] bg-[#111214] px-[10px] text-[13px] text-[#f1f3f4] outline-none placeholder:text-[#777c84] focus:border-white/[0.22]"
                  maxLength={160}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="按姓名或邮箱搜索"
                  value={search}
                />
                <select
                  aria-label="新成员角色"
                  className="h-[34px] rounded-[8px] border border-white/[0.10] bg-[#242629] px-[9px] text-[13px] text-[#f1f3f4] outline-none"
                  onChange={(event) => setAddRole(event.target.value as ProjectRole)}
                  value={addRole}
                >
                  {roleOptions.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
                </select>
              </div>
              {search.trim() && (
                <WorkspaceMemberResults
                  busy={mutationBusy}
                  error={workspaceMembersQuery.error}
                  hasMore={workspaceMembersQuery.hasNextPage}
                  loading={workspaceMembersQuery.isPending}
                  loadingMore={workspaceMembersQuery.isFetchingNextPage}
                  members={workspaceCandidates}
                  onAdd={addMember}
                  onLoadMore={() => void workspaceMembersQuery.fetchNextPage()}
                  onRetry={() => void workspaceMembersQuery.refetch()}
                />
              )}
              <div className="mt-[13px] flex flex-wrap gap-[8px] border-t border-white/[0.06] pt-[12px]">
                <input
                  aria-label="邀请外部成员邮箱"
                  className="h-[34px] min-w-[220px] flex-1 rounded-[8px] border border-white/[0.10] bg-[#111214] px-[10px] text-[13px] text-[#f1f3f4] outline-none placeholder:text-[#777c84] focus:border-white/[0.22]"
                  maxLength={320}
                  onChange={(event) => {
                    setInviteEmail(event.target.value);
                    setCreatedInvitationId(null);
                  }}
                  placeholder="邀请外部成员邮箱"
                  type="email"
                  value={inviteEmail}
                />
                <button
                  className="flex h-[34px] shrink-0 items-center gap-[6px] rounded-[8px] bg-[#e8eaed] px-[11px] text-[12px] font-semibold text-[#202124] hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={mutationBusy || !normalizedInviteEmail.success}
                  onClick={() => void invite()}
                  type="button"
                >
                  <MailPlusIcon className="size-[13px]" />
                  创建邀请
                </button>
              </div>
              {createdInvitationId && (
                <div className="mt-[8px] text-[12px] leading-[16px] text-[#aeb3bb]" role="status">
                  邀请已创建，邮件投递未配置，请在待接受邀请中复制链接发送。
                </div>
              )}
            </section>
          )}

          {canManageMembers && (
            <section className="mt-[18px] border-t border-white/[0.08] pt-[16px]" aria-label="待接受邀请">
              <div className="mb-[8px] flex items-center justify-between text-[13px] font-semibold text-[#aeb3bb]">
                <span>待接受邀请</span>
                <span>{invitations.length} 条</span>
              </div>
              <InvitationList
                busy={mutationBusy}
                copiedInvitationId={copiedInvitationId}
                error={invitationsQuery.error}
                hasMore={invitationsQuery.hasNextPage}
                invitations={invitations}
                loading={invitationsQuery.isPending}
                loadingMore={invitationsQuery.isFetchingNextPage}
                onCopy={copyInvitation}
                onLoadMore={() => void invitationsQuery.fetchNextPage()}
                onRetry={() => void invitationsQuery.refetch()}
                onRevoke={revoke}
              />
            </section>
          )}
        </div>

        <DialogFooter className="min-h-[58px] items-center justify-between border-t border-white/[0.08] bg-[#18191b] px-[18px] py-[10px]">
          <span className="text-[12px] leading-[16px] text-[#9da2aa]">
            {canManageMembers ? "角色变更会立即应用" : "当前角色只能查看成员"}
          </span>
          <button
            className="h-[34px] rounded-[8px] bg-[#e8eaed] px-[15px] text-[13px] font-semibold text-[#202124] transition hover:bg-white"
            onClick={() => onOpenChange(false)}
            type="button"
          >
            完成
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InvitationList({
  busy,
  copiedInvitationId,
  error,
  hasMore,
  invitations,
  loading,
  loadingMore,
  onCopy,
  onLoadMore,
  onRetry,
  onRevoke,
}: {
  busy: boolean;
  copiedInvitationId: string | null;
  error: unknown;
  hasMore: boolean;
  invitations: ProjectInvitationListItem[];
  loading: boolean;
  loadingMore: boolean;
  onCopy: (item: ProjectInvitationListItem) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRevoke: (item: ProjectInvitationListItem) => void;
}) {
  if (loading) {
    return <div className="rounded-[10px] border border-white/[0.08] bg-[#111214] px-[12px] py-[14px] text-center text-[12px] text-[#9da2aa]">正在读取邀请...</div>;
  }
  if (error) {
    return (
      <div className="flex items-center justify-center gap-[8px] rounded-[10px] border border-[#d96868]/35 bg-[#6e2525]/12 px-[12px] py-[12px] text-[12px] text-[#f0aaaa]">
        <span>邀请列表加载失败</span>
        <button className="text-[#d8dce2] underline" onClick={onRetry} type="button">重试</button>
      </div>
    );
  }
  if (invitations.length === 0) {
    return <div className="rounded-[10px] border border-white/[0.08] bg-[#111214] px-[12px] py-[14px] text-center text-[12px] text-[#9da2aa]">暂无待接受邀请</div>;
  }

  return (
    <div className="divide-y divide-white/[0.07] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#111214]">
      {invitations.map((item) => {
        const invitation = item.invitation;
        const copied = copiedInvitationId === invitation.id;
        return (
          <div className="flex min-h-[54px] items-center gap-[9px] px-[10px] py-[7px]" key={invitation.id}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-semibold text-[#e8eaed]">{invitation.email}</span>
              <span className="block truncate text-[12px] text-[#8f949c]">
                {roleLabels[invitation.role]} · {formatInvitationExpiry(invitation.expiresAt)} · 邮件未配置
              </span>
            </span>
            <button
              aria-label={`复制 ${invitation.email} 的邀请链接`}
              className="grid size-[30px] shrink-0 place-items-center rounded-full text-[#c8cbd0] hover:bg-white/[0.08] hover:text-white disabled:opacity-35"
              disabled={busy || !item.token}
              onClick={() => onCopy(item)}
              title={copied ? "已复制" : "复制邀请链接"}
              type="button"
            >
              <CopyIcon className="size-[14px]" />
            </button>
            <button
              aria-label={`撤销 ${invitation.email} 的邀请`}
              className="grid size-[30px] shrink-0 place-items-center rounded-full text-[#c8cbd0] hover:bg-white/[0.08] hover:text-[#f2a7a7] disabled:opacity-35"
              disabled={busy}
              onClick={() => onRevoke(item)}
              title="撤销邀请"
              type="button"
            >
              <Trash2Icon className="size-[14px]" />
            </button>
          </div>
        );
      })}
      {hasMore && (
        <LoadMoreButton
          label="加载更多邀请"
          loading={loadingMore}
          onClick={onLoadMore}
        />
      )}
    </div>
  );
}

function MemberList({
  canManageMembers,
  error,
  loading,
  members,
  mutationBusy,
  onRemove,
  onRetry,
  onRoleChange,
  ownerCount,
}: {
  canManageMembers: boolean;
  error: unknown;
  loading: boolean;
  members: ProjectMember[];
  mutationBusy: boolean;
  onRemove: (member: ProjectMember) => void;
  onRetry: () => void;
  onRoleChange: (member: ProjectMember, role: ProjectRole) => void;
  ownerCount: number;
}) {
  if (loading) return <div className="rounded-[10px] border border-white/[0.08] bg-[#111214] px-[12px] py-[18px] text-center text-[13px] text-[#9da2aa]">正在读取成员...</div>;
  if (error) {
    return (
      <div className="rounded-[10px] border border-[#d96868]/35 bg-[#6e2525]/12 px-[12px] py-[14px] text-center text-[13px] text-[#f0aaaa]">
        <div>成员列表加载失败</div>
        <button className="mt-[8px] inline-flex h-[28px] items-center gap-[6px] rounded-[7px] border border-white/[0.12] px-[9px] font-semibold hover:bg-white/[0.06]" onClick={onRetry} type="button">
          <RefreshCwIcon className="size-[13px]" />
          重试
        </button>
      </div>
    );
  }
  if (members.length === 0) return <div className="rounded-[10px] border border-white/[0.08] bg-[#111214] px-[12px] py-[18px] text-center text-[13px] text-[#9da2aa]">暂无项目成员</div>;

  return (
    <div className="divide-y divide-white/[0.07] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#111214]">
      {members.map((member) => {
        const label = member.displayName?.trim() || member.email || member.principalId;
        const isLastOwner = member.role === "owner" && ownerCount <= 1;
        return (
          <div className="flex min-h-[58px] items-center gap-[10px] px-[11px] py-[8px]" key={member.principalId}>
            <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-[#34363a] text-[12px] font-semibold text-[#e8eaed]">
              {initials(label)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[#f1f3f4]">{label}</span>
              <span className="block truncate text-[12px] text-[#8f949c]">{member.email ?? member.principalId}</span>
            </span>
            {canManageMembers ? (
              <select
                aria-label={`${label}角色`}
                className="h-[30px] max-w-[92px] rounded-[7px] border border-white/[0.10] bg-[#242629] px-[7px] text-[12px] text-[#f1f3f4] outline-none disabled:opacity-45"
                disabled={mutationBusy}
                onChange={(event) => void onRoleChange(member, event.target.value as ProjectRole)}
                value={member.role}
              >
                {roleOptions.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
              </select>
            ) : (
              <span className="rounded-full bg-[#2b2d31] px-[8px] py-[5px] text-[12px] font-semibold text-[#c8cbd0]">{roleLabels[member.role]}</span>
            )}
            {canManageMembers && (
              <button
                aria-label={`移除 ${label}`}
                className={cn(
                  "grid size-[30px] shrink-0 place-items-center rounded-full text-[#c8cbd0] hover:bg-white/[0.08] hover:text-[#f2a7a7] disabled:cursor-not-allowed disabled:opacity-35",
                )}
                disabled={mutationBusy || isLastOwner}
                onClick={() => void onRemove(member)}
                title={isLastOwner ? "项目必须保留至少一位所有者" : "移除成员"}
                type="button"
              >
                <Trash2Icon className="size-[14px]" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WorkspaceMemberResults({
  busy,
  error,
  hasMore,
  loading,
  loadingMore,
  members,
  onAdd,
  onLoadMore,
  onRetry,
}: {
  busy: boolean;
  error: unknown;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  members: WorkspaceMember[];
  onAdd: (member: WorkspaceMember) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  if (loading) return <div className="mt-[9px] px-[4px] text-[12px] text-[#9da2aa]">正在搜索...</div>;
  if (error) return <div className="mt-[9px] flex items-center gap-[8px] text-[12px] text-[#f0aaaa]"><span>搜索失败</span><button className="text-[#d8dce2] underline" onClick={onRetry} type="button">重试</button></div>;
  if (members.length === 0) return <div className="mt-[9px] px-[4px] text-[12px] text-[#9da2aa]">没有可添加的工作区成员</div>;

  return (
    <div className="mt-[9px] divide-y divide-white/[0.07] overflow-hidden rounded-[9px] border border-white/[0.08] bg-[#111214]">
      {members.map((member) => {
        const label = member.displayName?.trim() || member.email || member.principalId;
        return (
          <div className="flex min-h-[44px] items-center gap-[9px] px-[10px]" key={member.principalId}>
            <span className="min-w-0 flex-1 truncate text-[12px] text-[#d8dce2]">{label}{member.email && member.displayName ? ` · ${member.email}` : ""}</span>
            <button
              className="flex h-[27px] shrink-0 items-center gap-[5px] rounded-[7px] bg-[#e8eaed] px-[9px] text-[12px] font-semibold text-[#202124] hover:bg-white disabled:opacity-45"
              disabled={busy}
              onClick={() => onAdd(member)}
              type="button"
            >
              <UserPlusIcon className="size-[12px]" />
              添加
            </button>
          </div>
        );
      })}
      {hasMore && (
        <LoadMoreButton
          label="加载更多工作区成员"
          loading={loadingMore}
          onClick={onLoadMore}
        />
      )}
    </div>
  );
}

function LoadMoreButton({
  label,
  loading,
  onClick,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex h-[36px] w-full items-center justify-center border-t border-white/[0.07] text-[12px] font-semibold text-[#c8cbd0] hover:bg-white/[0.05] disabled:cursor-wait disabled:opacity-50"
      disabled={loading}
      onClick={onClick}
      type="button"
    >
      {loading ? "正在加载..." : "加载更多"}
    </button>
  );
}

function initials(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 2).toUpperCase();
}

function formatInvitationExpiry(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "到期时间未知";
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)} 到期`;
}

function memberOperationError(error: unknown): string {
  if (isWorkbenchApiError(error) && error.status === 412) {
    return "项目已在其他位置更新，请刷新成员列表后重试";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "成员操作失败，请重试";
}

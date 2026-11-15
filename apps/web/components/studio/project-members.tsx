"use client";
import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  ProjectBootstrap,
  ProjectMember,
  ProjectRole,
  ProjectInvitationStatus,
} from "@workbench/workbench-contracts";
import { useWorkbenchProjectsApi } from "@/lib/studio/api";
import { projectInvitationAcceptUrl } from "@/lib/workbench/features/projects";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { useStudioAction } from "./actions";

export const projectRoleLabels: Record<ProjectRole, string> = {
  owner: "所有者",
  editor: "编辑成员",
  viewer: "只读成员",
};
const invitationLabels = {
  pending: "待接受",
  accepted: "已接受",
  revoked: "已撤销",
  expired: "已过期",
};

export function CopyableLink({ url, label }: { url: string; label: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="studio-copy-link">
      <label>
        {label}
        <input
          aria-label={label}
          value={url}
          readOnly
          onFocus={(event) => event.target.select()}
        />
      </label>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setMessage("链接已复制");
          } catch {
            setMessage("自动复制不可用，请选中上方链接手动复制。");
          }
        }}
      >
        复制{label}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export function ProjectMembers({ bootstrap }: { bootstrap: ProjectBootstrap }) {
  const api = useWorkbenchProjectsApi(),
    client = useQueryClient(),
    action = useStudioAction();
  const project = bootstrap.project,
    owner = bootstrap.access.role === "owner";
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<ProjectRole>("viewer");
  const [filter, setFilter] = useState<ProjectInvitationStatus | "all">("all");
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState("");
  const [addRole, setAddRole] = useState<ProjectRole>("viewer");
  const intent = useRef<{ signature: string; key: string } | null>(null);
  const members = useQuery({
    queryKey: ["studio", "members", project.id],
    queryFn: () => api.listProjectMembers(project.id),
  });
  const invitations = useInfiniteQuery({
    queryKey: ["studio", "invitations", project.id, filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listProjectInvitations(project.id, {
        cursor: pageParam,
        limit: 30,
        ...(filter === "all" ? {} : { status: filter }),
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: owner,
  });
  const directory = useInfiniteQuery({
    queryKey: ["studio", "member-directory", project.workspaceId, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listWorkspaceMembers(project.workspaceId, {
        cursor: pageParam,
        limit: 30,
        q: search.trim() || undefined,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: owner,
  });
  const refresh = async () => {
    await client.invalidateQueries({
      queryKey: workbenchQueryKeys.bootstraps(project.id),
    });
    await Promise.all([
      client.invalidateQueries({ queryKey: ["studio", "members", project.id] }),
      client.invalidateQueries({
        queryKey: ["studio", "invitations", project.id],
      }),
    ]);
  };
  const owners =
    members.data?.items.filter((member) => member.role === "owner").length ?? 0;
  return (
    <section aria-label="成员与邀请">
      <h2>成员与邀请</h2>
      {action.notice}
      {members.isPending && <p role="status">正在读取项目成员…</p>}
      {members.error && (
        <p role="alert">
          成员读取失败。
          <button onClick={() => void members.refetch()}>重试成员</button>
        </p>
      )}
      {!owner && <p>只有项目所有者可以管理成员与邀请。</p>}
      {members.data?.items.map((member) => (
        <MemberRow
          key={member.principalId}
          member={member}
          owner={owner}
          onlyOwner={member.role === "owner" && owners === 1}
          busy={action.busy}
          onRole={(next) =>
            action.run(async () => {
              await api.setProjectMemberRole(
                project.id,
                member.principalId,
                { role: next },
                `"${project.revision}"`,
              );
              await refresh();
            }, "成员角色已更新")
          }
          onRemove={() =>
            action.run(async () => {
              await api.removeProjectMember(
                project.id,
                member.principalId,
                `"${project.revision}"`,
              );
              await refresh();
            }, "成员已移除")
          }
        />
      ))}
      {owner && (
        <>
          <details>
            <summary>添加已有工作区成员</summary>
            <label>
              查找成员
              <input
                aria-label="查找工作区成员"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelected("");
                }}
              />
            </label>
            {directory.error && (
              <p role="alert">
                工作区成员读取失败。
                <button onClick={() => void directory.refetch()}>
                  重试工作区成员
                </button>
              </p>
            )}
            <select
              aria-label="待添加的工作区成员"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">选择成员</option>
              {directory.data?.pages
                .flatMap((page) => page.items)
                .filter(
                  (person) =>
                    !members.data?.items.some(
                      (member) => member.principalId === person.principalId,
                    ),
                )
                .map((person) => (
                  <option key={person.principalId} value={person.principalId}>
                    {person.displayName || person.email || person.principalId}
                  </option>
                ))}
            </select>
            <RoleSelect
              label="新增成员角色"
              value={addRole}
              onChange={setAddRole}
            />
            <button
              disabled={action.busy || !selected || !members.data}
              onClick={() =>
                void action.run(async () => {
                  await api.setProjectMemberRole(
                    project.id,
                    selected,
                    { role: addRole },
                    `"${project.revision}"`,
                  );
                  setSelected("");
                  await refresh();
                }, "成员已添加")
              }
            >
              添加到项目
            </button>
            {directory.hasNextPage && (
              <button
                disabled={directory.isFetchingNextPage}
                onClick={() => void directory.fetchNextPage()}
              >
                加载更多工作区成员
              </button>
            )}
          </details>
          <h3>邀请成员</h3>
          <p>
            邀请邮件尚未配置。创建后请复制链接，交给指定邮箱的用户登录并接受。
          </p>
          <form
            className="studio-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                const request = { email: email.trim().toLowerCase(), role },
                  signature = JSON.stringify({
                    projectId: project.id,
                    ...request,
                  });
                if (intent.current?.signature !== signature)
                  intent.current = {
                    signature,
                    key: createIdempotencyKey("studio-invitation"),
                  };
                await api.createProjectInvitation(
                  project.id,
                  request,
                  `"${project.revision}"`,
                  intent.current.key,
                );
                intent.current = null;
                setEmail("");
                setFilter("all");
                await refresh();
              }, "邀请已创建，请复制邀请列表中的链接");
            }}
          >
            <input
              type="email"
              aria-label="邀请邮箱"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={320}
            />
            <RoleSelect label="邀请角色" value={role} onChange={setRole} />
            <button disabled={action.busy || !email.trim()}>创建邀请</button>
          </form>
          <label>
            邀请状态
            <select
              aria-label="邀请状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">全部</option>
              {Object.entries(invitationLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {invitations.isPending && <p role="status">正在读取邀请…</p>}
          {invitations.error && (
            <p role="alert">
              邀请读取失败。
              <button onClick={() => void invitations.refetch()}>
                重试邀请
              </button>
            </p>
          )}
          {invitations.data?.pages
            .flatMap((page) => page.items)
            .map(({ invitation, token }) => {
              const expired =
                invitation.status === "pending" &&
                Date.parse(invitation.expiresAt) <= Date.now();
              return (
                <article
                  className="studio-card"
                  key={invitation.id}
                  aria-label={`邀请 ${invitation.email}`}
                >
                  <h3>{invitation.email}</h3>
                  <p>
                    {projectRoleLabels[invitation.role]} ·{" "}
                    {expired ? "已过期" : invitationLabels[invitation.status]} ·
                    到期 {new Date(invitation.expiresAt).toLocaleString()}
                  </p>
                  {token && !expired && (
                    <CopyableLink
                      label="邀请链接"
                      url={projectInvitationAcceptUrl(
                        token,
                        window.location.origin,
                      )}
                    />
                  )}
                  {invitation.status === "pending" && !expired && (
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api.revokeProjectInvitation(
                            project.id,
                            invitation.id,
                            `"${project.revision}"`,
                          );
                          await refresh();
                        }, "邀请已撤销")
                      }
                    >
                      撤销邀请
                    </button>
                  )}
                </article>
              );
            })}
          {invitations.data?.pages[0]?.items.length === 0 && (
            <p>没有符合当前条件的邀请。</p>
          )}
          {invitations.hasNextPage && (
            <button
              disabled={invitations.isFetchingNextPage}
              onClick={() => void invitations.fetchNextPage()}
            >
              加载更多邀请
            </button>
          )}
        </>
      )}
    </section>
  );
}
function RoleSelect({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ProjectRole)}
    >
      {Object.entries(projectRoleLabels).map(([role, label]) => (
        <option key={role} value={role}>
          {label}
        </option>
      ))}
    </select>
  );
}
function MemberRow({
  member,
  owner,
  onlyOwner,
  busy,
  onRole,
  onRemove,
}: {
  member: ProjectMember;
  owner: boolean;
  onlyOwner: boolean;
  busy: boolean;
  onRole: (role: ProjectRole) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [role, setRole] = useState(member.role),
    name = member.displayName || member.email || member.principalId;
  return (
    <article className="studio-card" aria-label={`成员 ${name}`}>
      <h3>{name}</h3>
      <p>{projectRoleLabels[member.role]}</p>
      {owner && (
        <>
          <RoleSelect
            label={`${name}的角色`}
            value={role}
            onChange={setRole}
            disabled={busy || onlyOwner}
          />
          <button
            disabled={busy || onlyOwner || role === member.role}
            onClick={() => void onRole(role)}
          >
            保存成员角色
          </button>
          {onlyOwner ? (
            <p>项目至少需要一位所有者。</p>
          ) : (
            <details>
              <summary>移除成员</summary>
              <p>移除后，此成员将失去项目访问权限。</p>
              <button disabled={busy} onClick={() => void onRemove()}>
                确认移除 {name}
              </button>
            </details>
          )}
        </>
      )}
    </article>
  );
}

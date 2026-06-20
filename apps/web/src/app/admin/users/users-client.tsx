"use client";

import { Home, KeyRound, Plus, RotateCcw, Search, ShieldCheck, UserCog } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "@/components/modal";
import { ProtectedRoute } from "@/components/protected-route";
import { Button, FieldLabel, InlineError, RoleBadge, Select, StatusBadge, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { AdminUser, UserRole, UserStatus, UsersResponse } from "@/lib/types";

type ModalState = "create" | "edit" | "reset" | "disable" | null;

type CreateForm = {
  username: string;
  displayName: string;
  email: string;
  password: string;
  role: UserRole;
  status: UserStatus;
};

type EditForm = {
  displayName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
};

const defaultCreateForm: CreateForm = {
  username: "",
  displayName: "",
  email: "",
  password: "",
  role: "user",
  status: "active",
};

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AdminUsersClient() {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState<UserRole | "">("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(defaultCreateForm);
  const [editForm, setEditForm] = useState<EditForm>({
    displayName: "",
    email: "",
    role: "user",
    status: "active",
  });
  const [passwordForm, setPasswordForm] = useState({ password: "", confirmPassword: "" });

  const totalPages = useMemo(() => Math.max(Math.ceil(total / pageSize), 1), [pageSize, total]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQueryString({
        keyword: keyword.trim() || undefined,
        role: role || undefined,
        status: status || undefined,
        page,
        pageSize,
      });
      const result = await apiRequest<UsersResponse>(`/admin/users${query}`);
      setUsers(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "用户列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, page, pageSize, role, status]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  function openCreate() {
    setCreateForm(defaultCreateForm);
    setModalError(null);
    setModal("create");
  }

  function openEdit(user: AdminUser) {
    setSelectedUser(user);
    setEditForm({
      displayName: user.displayName,
      email: user.email ?? "",
      role: user.role,
      status: user.status,
    });
    setModalError(null);
    setModal("edit");
  }

  function openReset(user: AdminUser) {
    setSelectedUser(user);
    setPasswordForm({ password: "", confirmPassword: "" });
    setModalError(null);
    setModal("reset");
  }

  function openDisable(user: AdminUser) {
    setSelectedUser(user);
    setModalError(null);
    setModal("disable");
  }

  function closeModal() {
    if (submitting) return;
    setModal(null);
    setSelectedUser(null);
    setModalError(null);
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setModalError(null);

    if (!createForm.username.trim() || !createForm.displayName.trim() || !createForm.password) {
      setModalError("用户名、显示名称和初始密码不能为空");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest<AdminUser>("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: createForm.username.trim(),
          displayName: createForm.displayName.trim(),
          email: createForm.email.trim() || undefined,
          password: createForm.password,
          role: createForm.role,
          status: createForm.status,
        }),
      });
      setNotice("用户已创建");
      closeModalAfterSubmit();
      await loadUsers();
    } catch (submitError) {
      setModalError(submitError instanceof Error ? submitError.message : "创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUser) return;
    setModalError(null);

    if (!editForm.displayName.trim()) {
      setModalError("显示名称不能为空");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest<AdminUser>(`/admin/users/${selectedUser.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: editForm.displayName.trim(),
          email: editForm.email.trim() || null,
          role: editForm.role,
          status: editForm.status,
        }),
      });
      setNotice("用户已保存");
      closeModalAfterSubmit();
      await loadUsers();
    } catch (submitError) {
      setModalError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedUser) return;
    setModalError(null);

    if (!passwordForm.password) {
      setModalError("新密码不能为空");
      return;
    }

    if (passwordForm.password !== passwordForm.confirmPassword) {
      setModalError("两次密码必须一致");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest<{ success: true }>(`/admin/users/${selectedUser.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: passwordForm.password }),
      });
      setNotice("密码已重置");
      closeModalAfterSubmit();
    } catch (submitError) {
      setModalError(submitError instanceof Error ? submitError.message : "重置失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitStatusChange() {
    if (!selectedUser) return;
    setSubmitting(true);
    setModalError(null);
    const action = selectedUser.status === "active" ? "disable" : "enable";
    try {
      await apiRequest<{ success: true }>(`/admin/users/${selectedUser.id}/${action}`, {
        method: "POST",
      });
      setNotice(selectedUser.status === "active" ? "用户已禁用" : "用户已启用");
      closeModalAfterSubmit();
      await loadUsers();
    } catch (submitError) {
      setModalError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  function closeModalAfterSubmit() {
    setModal(null);
    setSelectedUser(null);
    setModalError(null);
  }

  return (
    <ProtectedRoute requireAdmin>
      <main className="grid min-h-screen grid-cols-[220px_1fr] bg-[#F6F7F9] text-gray-950">
        <aside className="border-r border-gray-200 bg-white px-4 py-6">
          <div className="px-2 text-base font-semibold">管理后台</div>
          <nav className="mt-8 space-y-2">
            <button className="flex h-10 w-full items-center gap-2 rounded-[10px] bg-gray-100 px-3 text-sm font-medium text-gray-900">
              <UserCog className="h-4 w-4" />
              用户管理
            </button>
            <button
              type="button"
              onClick={() => router.push("/workspace")}
              className="flex h-10 w-full items-center gap-2 rounded-[10px] px-3 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              <Home className="h-4 w-4" />
              返回工作台
            </button>
          </nav>
        </aside>

        <section className="px-8 py-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-gray-950">用户管理</h1>
              <p className="mt-2 text-sm text-gray-500">管理内测用户账号、角色和启用状态</p>
            </div>
            <Button type="button" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              新建用户
            </Button>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-4 py-4">
            <div className="relative w-[280px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <TextInput
                value={keyword}
                onChange={(event) => {
                  setKeyword(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索用户名或邮箱"
                className="h-10 pl-9"
              />
            </div>
            <Select
              value={role}
              onChange={(event) => {
                setRole(event.target.value as UserRole | "");
                setPage(1);
              }}
            >
              <option value="">全部角色</option>
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </Select>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as UserStatus | "");
                setPage(1);
              }}
            >
              <option value="">全部状态</option>
              <option value="active">启用</option>
              <option value="disabled">禁用</option>
            </Select>
            <Button type="button" variant="ghost" onClick={() => void loadUsers()}>
              <RotateCcw className="h-4 w-4" />
              刷新
            </Button>
          </div>

          {notice ? (
            <div className="mt-4 rounded-[10px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {notice}
            </div>
          ) : null}
          {error ? <div className="mt-4"><InlineError message={error} /></div> : null}

          <div className="mt-4 overflow-hidden border border-gray-200 bg-white">
            <div className="overflow-x-auto">
              <table className="min-w-[1080px] w-full border-collapse text-left text-sm">
                <thead className="bg-gray-50 text-xs font-medium text-gray-500">
                  <tr>
                    <th className="px-4 py-3">用户名</th>
                    <th className="px-4 py-3">显示名称</th>
                    <th className="px-4 py-3">邮箱</th>
                    <th className="px-4 py-3">角色</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">最近登录</th>
                    <th className="px-4 py-3">创建时间</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 text-gray-700">
                  {loading ? <LoadingRows /> : null}
                  {!loading && users.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-16 text-center text-sm text-gray-500">
                        暂无用户
                      </td>
                    </tr>
                  ) : null}
                  {!loading
                    ? users.map((user) => (
                        <tr key={user.id} className="hover:bg-gray-50/70">
                          <td className="px-4 py-3 font-medium text-gray-950">{user.username}</td>
                          <td className="px-4 py-3">{user.displayName}</td>
                          <td className="px-4 py-3 text-gray-500">{user.email ?? "-"}</td>
                          <td className="px-4 py-3"><RoleBadge role={user.role} /></td>
                          <td className="px-4 py-3"><StatusBadge status={user.status} /></td>
                          <td className="px-4 py-3 text-gray-500">{formatDate(user.lastLoginAt)}</td>
                          <td className="px-4 py-3 text-gray-500">{formatDate(user.createdAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end gap-2">
                              <Button type="button" variant="ghost" onClick={() => openEdit(user)}>
                                编辑
                              </Button>
                              <Button type="button" variant="ghost" onClick={() => openReset(user)}>
                                重置密码
                              </Button>
                              <Button
                                type="button"
                                variant={user.status === "active" ? "ghost" : "secondary"}
                                onClick={() => openDisable(user)}
                              >
                                {user.status === "active" ? "禁用" : "启用"}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
            <div>
              共 {total} 个用户，第 {page} / {totalPages} 页
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(value - 1, 1))}
              >
                上一页
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((value) => Math.min(value + 1, totalPages))}
              >
                下一页
              </Button>
            </div>
          </div>
        </section>

        <CreateUserModal
          open={modal === "create"}
          form={createForm}
          error={modalError}
          submitting={submitting}
          onChange={setCreateForm}
          onClose={closeModal}
          onSubmit={submitCreate}
        />
        <EditUserModal
          open={modal === "edit"}
          form={editForm}
          error={modalError}
          submitting={submitting}
          onChange={setEditForm}
          onClose={closeModal}
          onSubmit={submitEdit}
        />
        <ResetPasswordModal
          open={modal === "reset"}
          form={passwordForm}
          error={modalError}
          submitting={submitting}
          onChange={setPasswordForm}
          onClose={closeModal}
          onSubmit={submitReset}
        />
        <StatusConfirmModal
          open={modal === "disable"}
          user={selectedUser}
          error={modalError}
          submitting={submitting}
          onClose={closeModal}
          onConfirm={() => void submitStatusChange()}
        />
      </main>
    </ProtectedRoute>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <tr key={index}>
          {Array.from({ length: 8 }).map((__, cellIndex) => (
            <td key={cellIndex} className="px-4 py-3">
              <div className="h-5 animate-pulse rounded bg-gray-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function CreateUserModal({
  open,
  form,
  error,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  form: CreateForm;
  error: string | null;
  submitting: boolean;
  onChange: (value: CreateForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal
      open={open}
      title="新建用户"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button form="create-user-form" type="submit" disabled={submitting}>
            {submitting ? "创建中..." : "创建"}
          </Button>
        </>
      }
    >
      <form id="create-user-form" onSubmit={onSubmit} className="space-y-4">
        <FormGrid>
          <FormControl label="用户名">
            <TextInput
              value={form.username}
              onChange={(event) => onChange({ ...form, username: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="显示名称">
            <TextInput
              value={form.displayName}
              onChange={(event) => onChange({ ...form, displayName: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="邮箱">
            <TextInput
              value={form.email}
              onChange={(event) => onChange({ ...form, email: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="初始密码">
            <TextInput
              type="password"
              value={form.password}
              onChange={(event) => onChange({ ...form, password: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="角色">
            <Select
              value={form.role}
              onChange={(event) => onChange({ ...form, role: event.target.value as UserRole })}
              disabled={submitting}
              className="w-full"
            >
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </Select>
          </FormControl>
          <FormControl label="状态">
            <Select
              value={form.status}
              onChange={(event) => onChange({ ...form, status: event.target.value as UserStatus })}
              disabled={submitting}
              className="w-full"
            >
              <option value="active">启用</option>
              <option value="disabled">禁用</option>
            </Select>
          </FormControl>
        </FormGrid>
        <InlineError message={error} />
      </form>
    </Modal>
  );
}

function EditUserModal({
  open,
  form,
  error,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  form: EditForm;
  error: string | null;
  submitting: boolean;
  onChange: (value: EditForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal
      open={open}
      title="编辑用户"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button form="edit-user-form" type="submit" disabled={submitting}>
            {submitting ? "保存中..." : "保存"}
          </Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={onSubmit} className="space-y-4">
        <FormGrid>
          <FormControl label="显示名称">
            <TextInput
              value={form.displayName}
              onChange={(event) => onChange({ ...form, displayName: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="邮箱">
            <TextInput
              value={form.email}
              onChange={(event) => onChange({ ...form, email: event.target.value })}
              disabled={submitting}
            />
          </FormControl>
          <FormControl label="角色">
            <Select
              value={form.role}
              onChange={(event) => onChange({ ...form, role: event.target.value as UserRole })}
              disabled={submitting}
              className="w-full"
            >
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </Select>
          </FormControl>
          <FormControl label="状态">
            <Select
              value={form.status}
              onChange={(event) => onChange({ ...form, status: event.target.value as UserStatus })}
              disabled={submitting}
              className="w-full"
            >
              <option value="active">启用</option>
              <option value="disabled">禁用</option>
            </Select>
          </FormControl>
        </FormGrid>
        <InlineError message={error} />
      </form>
    </Modal>
  );
}

function ResetPasswordModal({
  open,
  form,
  error,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  form: { password: string; confirmPassword: string };
  error: string | null;
  submitting: boolean;
  onChange: (value: { password: string; confirmPassword: string }) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal
      open={open}
      title="重置密码"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button form="reset-password-form" type="submit" disabled={submitting}>
            {submitting ? "重置中..." : "确认重置"}
          </Button>
        </>
      }
    >
      <form id="reset-password-form" onSubmit={onSubmit} className="space-y-4">
        <FormControl label="新密码">
          <TextInput
            type="password"
            value={form.password}
            onChange={(event) => onChange({ ...form, password: event.target.value })}
            disabled={submitting}
          />
        </FormControl>
        <FormControl label="确认新密码">
          <TextInput
            type="password"
            value={form.confirmPassword}
            onChange={(event) => onChange({ ...form, confirmPassword: event.target.value })}
            disabled={submitting}
          />
        </FormControl>
        <InlineError message={error} />
      </form>
    </Modal>
  );
}

function StatusConfirmModal({
  open,
  user,
  error,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  user: AdminUser | null;
  error: string | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const disabling = user?.status === "active";

  return (
    <Modal
      open={open}
      title={disabling ? "确认禁用用户？" : "确认启用用户？"}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button
            type="button"
            variant={disabling ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting ? "处理中..." : disabling ? "确认禁用" : "确认启用"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-[10px] bg-gray-50 px-4 py-3">
          {disabling ? <ShieldCheck className="h-5 w-5 text-gray-700" /> : <KeyRound className="h-5 w-5 text-gray-700" />}
          <div>
            <div className="text-sm font-medium text-gray-950">{user?.displayName}</div>
            <div className="text-xs text-gray-500">{user?.username}</div>
          </div>
        </div>
        <p className="text-sm leading-6 text-gray-600">
          {disabling ? "禁用后，该用户将无法登录系统。" : "启用后，该用户可以重新登录系统。"}
        </p>
        <InlineError message={error} />
      </div>
    </Modal>
  );
}

function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function FormControl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}

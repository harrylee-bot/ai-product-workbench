"use client";

import { RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "@/components/admin-shell";
import {
  AdminDrawer,
  AdminFilterBar,
  AdminPagination,
  AdminStatusBadge,
  AdminTable,
  DetailGrid,
  DetailItem,
  EmptyRow,
  JsonViewer,
  LoadingRows,
} from "@/components/admin-ui";
import { Button, InlineError, Select, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/types";

type AuditLog = {
  id: string;
  adminUserId: string;
  adminUsername: string;
  adminDisplayName: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  userAgent?: string;
  createdAt: string;
};

const targetTypes = ["user", "project", "model_provider", "model_config", "model_task_profile", "knowledge_item", "knowledge_candidate", "system"];

export function AdminAuditLogsClient() {
  const [adminUserId, setAdminUserId] = useState("");
  const [action, setAction] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQueryString({
        adminUserId: adminUserId.trim() || undefined,
        action: action.trim() || undefined,
        targetType: targetType || undefined,
        targetId: targetId.trim() || undefined,
        page,
        pageSize,
      });
      const result = await apiRequest<PaginatedResponse<AuditLog>>(`/admin/audit-logs${query}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "审计日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [action, adminUserId, page, pageSize, targetId, targetType]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  return (
    <AdminShell title="系统审计">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-gray-950">系统审计</h2>
        <p className="mt-2 text-sm text-gray-500">管理员关键操作记录与目标追踪</p>
      </div>
      <AdminFilterBar>
        <div className="relative w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <TextInput value={adminUserId} onChange={(event) => { setAdminUserId(event.target.value); setPage(1); }} placeholder="adminUserId" className="h-10 pl-9" />
        </div>
        <TextInput value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} placeholder="action" className="h-10 w-[200px]" />
        <Select value={targetType} onChange={(event) => { setTargetType(event.target.value); setPage(1); }}>
          <option value="">全部目标</option>
          {targetTypes.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <TextInput value={targetId} onChange={(event) => { setTargetId(event.target.value); setPage(1); }} placeholder="targetId" className="h-10 w-[220px]" />
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
      <div className="mt-4">
        <AdminTable columns={["管理员", "Action", "目标类型", "目标 ID", "IP", "时间", "操作"]} minWidth={1100}>
          {loading ? <LoadingRows columns={7} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={7} label="暂无审计日志" /> : null}
          {!loading ? items.map((log) => (
            <tr key={log.id} className="hover:bg-gray-50/70">
              <td className="px-4 py-3"><div className="font-medium text-gray-950">{log.adminDisplayName}</div><div className="text-xs text-gray-500">{log.adminUsername}</div></td>
              <td className="px-4 py-3"><AdminStatusBadge label={log.action} tone="blue" /></td>
              <td className="px-4 py-3">{log.targetType}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-600">{log.targetId ?? "-"}</td>
              <td className="px-4 py-3 text-gray-500">{log.ip ?? "-"}</td>
              <td className="px-4 py-3 text-gray-500">{formatDate(log.createdAt)}</td>
              <td className="px-4 py-3 text-right"><Button type="button" variant="ghost" onClick={() => setSelected(log)}>详情</Button></td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <AdminPagination page={page} pageSize={pageSize} total={total} loading={loading} onPageChange={setPage} />
      <AdminDrawer open={Boolean(selected)} title={selected?.action ?? "审计详情"} onClose={() => setSelected(null)}>
        {selected ? (
          <div className="space-y-5">
            <DetailGrid>
              <DetailItem label="管理员" value={`${selected.adminDisplayName} / ${selected.adminUsername}`} />
              <DetailItem label="Action" value={selected.action} />
              <DetailItem label="目标类型" value={selected.targetType} />
              <DetailItem label="目标 ID" value={selected.targetId ?? "-"} />
              <DetailItem label="IP" value={selected.ip ?? "-"} />
              <DetailItem label="时间" value={formatDate(selected.createdAt)} />
            </DetailGrid>
            <section>
              <h3 className="mb-3 text-sm font-semibold text-gray-950">Detail</h3>
              <JsonViewer value={selected.detail ?? {}} />
            </section>
          </div>
        ) : null}
      </AdminDrawer>
    </AdminShell>
  );
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

"use client";

import { Plus, RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  LoadingRows,
} from "@/components/admin-ui";
import { Modal } from "@/components/modal";
import { Button, FieldLabel, InlineError, Select, TextArea, TextInput } from "@/components/ui";
import { apiRequest, toQueryString } from "@/lib/api";
import type { KnowledgeCandidate, KnowledgeItem, PaginatedResponse } from "@/lib/types";

type ItemForm = {
  title: string;
  content: string;
  summary: string;
  type: string;
  status: string;
  scope: string;
  tags: string;
  priority: string;
};

const knowledgeTypes = ["strong_rule", "default_rule", "reference_case", "design_pattern", "prd_writing_rule", "prototype_rule", "business_concept"];
const knowledgeStatuses = ["draft", "active", "disabled", "archived"];
const candidateStatuses = ["pending", "approved", "rejected", "merged"];

export function AdminKnowledgeItemsClient() {
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeItem | null>(null);
  const [form, setForm] = useState<ItemForm>(defaultItemForm());
  const [submitting, setSubmitting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQueryString({
        keyword: keyword.trim() || undefined,
        type: type || undefined,
        status: status || undefined,
        page,
        pageSize,
      });
      const result = await apiRequest<PaginatedResponse<KnowledgeItem>>(`/admin/knowledge/items${query}`);
      setItems(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "知识条目加载失败");
    } finally {
      setLoading(false);
    }
  }, [keyword, page, pageSize, status, type]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  function openCreate() {
    setEditing(null);
    setForm(defaultItemForm());
    setModalOpen(true);
  }

  function openEdit(item: KnowledgeItem) {
    setEditing(item);
    setForm({
      title: item.title,
      content: item.content,
      summary: item.summary ?? "",
      type: item.type,
      status: item.status,
      scope: item.scope,
      tags: item.tags.join(","),
      priority: item.priority,
    });
    setModalOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        title: form.title.trim(),
        content: form.content.trim(),
        summary: form.summary.trim() || undefined,
        type: form.type,
        status: form.status,
        scope: form.scope,
        tags: splitTags(form.tags),
        priority: form.priority,
      };
      if (editing) {
        await apiRequest<KnowledgeItem>(`/admin/knowledge/items/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...payload, changeSummary: "管理后台更新知识" }),
        });
        setNotice("知识条目已保存");
      } else {
        await apiRequest<KnowledgeItem>("/admin/knowledge/items", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setNotice("知识条目已创建");
      }
      setModalOpen(false);
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(item: KnowledgeItem) {
    setSubmitting(true);
    try {
      await apiRequest(`/admin/knowledge/items/${item.id}/${item.status === "active" ? "disable" : "enable"}`, {
        method: "POST",
      });
      setNotice(item.status === "active" ? "知识已禁用" : "知识已启用");
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell title="知识条目" actions={<Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />新建知识</Button>}>
      <Header title="知识条目" subtitle="强规则、默认规则、案例与设计模式沉淀" />
      <AdminFilterBar>
        <div className="relative w-[260px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <TextInput value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder="搜索知识" className="h-10 pl-9" />
        </div>
        <Select value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="">全部类型</option>{knowledgeTypes.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{knowledgeStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      <Feedback notice={notice} error={error} />
      <div className="mt-4">
        <AdminTable columns={["标题", "类型", "标签", "优先级", "状态", "来源", "更新时间", "操作"]} minWidth={1120}>
          {loading ? <LoadingRows columns={8} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={8} label="暂无知识条目" /> : null}
          {!loading ? items.map((item) => (
            <tr key={item.id} className="hover:bg-gray-50/70">
              <td className="px-4 py-3"><div className="font-medium text-gray-950">{item.title}</div><div className="mt-1 max-w-[300px] truncate text-xs text-gray-500">{item.summary ?? item.content}</div></td>
              <td className="px-4 py-3 text-gray-600">{item.type}</td>
              <td className="px-4 py-3 text-gray-500">{item.tags.join(", ") || "-"}</td>
              <td className="px-4 py-3">{item.priority}</td>
              <td className="px-4 py-3"><KnowledgeStatusBadge status={item.status} /></td>
              <td className="px-4 py-3 text-gray-500">{item.source}</td>
              <td className="px-4 py-3 text-gray-500">{formatDate(item.updatedAt)}</td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => openEdit(item)}>编辑</Button>
                  <Button type="button" variant="ghost" disabled={submitting} onClick={() => void toggle(item)}>{item.status === "active" ? "禁用" : "启用"}</Button>
                </div>
              </td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <AdminPagination page={page} pageSize={pageSize} total={total} loading={loading} onPageChange={setPage} />
      <KnowledgeItemModal open={modalOpen} editing={editing} form={form} submitting={submitting} onChange={setForm} onClose={() => setModalOpen(false)} onSubmit={submit} />
    </AdminShell>
  );
}

export function AdminKnowledgeCandidatesClient() {
  const [status, setStatus] = useState("pending");
  const [type, setType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [items, setItems] = useState<KnowledgeCandidate[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<KnowledgeCandidate | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [targetKnowledgeItemId, setTargetKnowledgeItemId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = toQueryString({
        status: status || undefined,
        suggestedType: type || undefined,
        projectId: projectId.trim() || undefined,
        page,
        pageSize,
      });
      const [candidateResult, knowledgeResult] = await Promise.all([
        apiRequest<PaginatedResponse<KnowledgeCandidate>>(`/admin/knowledge/candidates${query}`),
        apiRequest<PaginatedResponse<KnowledgeItem>>("/admin/knowledge/items?page=1&pageSize=100"),
      ]);
      setItems(candidateResult.items);
      setTotal(candidateResult.total);
      setKnowledgeItems(knowledgeResult.items);
      setTargetKnowledgeItemId(knowledgeResult.items[0]?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "知识候选加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, projectId, status, type]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function approve(candidate: KnowledgeCandidate) {
    await review(candidate, "approve", {});
  }

  async function reject(candidate: KnowledgeCandidate) {
    await review(candidate, "reject", { reviewComment: reviewComment.trim() || "不纳入知识库" });
  }

  async function merge(candidate: KnowledgeCandidate) {
    if (!targetKnowledgeItemId) {
      setError("请选择要合并的知识条目");
      return;
    }
    await review(candidate, "merge", { targetKnowledgeItemId, reviewComment: reviewComment.trim() || undefined });
  }

  async function review(candidate: KnowledgeCandidate, action: "approve" | "reject" | "merge", payload: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest(`/admin/knowledge/candidates/${candidate.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setNotice(action === "approve" ? "候选已通过" : action === "reject" ? "候选已拒绝" : "候选已合并");
      setSelected(null);
      setReviewComment("");
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "审核失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell title="知识候选">
      <Header title="知识候选" subtitle="从项目、PRD、原型和上传文件抽取的待审核知识" />
      <AdminFilterBar>
        <TextInput value={projectId} onChange={(event) => { setProjectId(event.target.value); setPage(1); }} placeholder="projectId" className="h-10 w-[220px]" />
        <Select value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}><option value="">全部类型</option>{knowledgeTypes.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{candidateStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      <Feedback notice={notice} error={error} />
      <div className="mt-4">
        <AdminTable columns={["标题", "建议类型", "来源项目", "置信度", "来源", "状态", "创建时间", "操作"]} minWidth={1120}>
          {loading ? <LoadingRows columns={8} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={8} label="暂无知识候选" /> : null}
          {!loading ? items.map((candidate) => (
            <tr key={candidate.id} className="hover:bg-gray-50/70">
              <td className="px-4 py-3"><div className="font-medium text-gray-950">{candidate.title}</div><div className="mt-1 max-w-[320px] truncate text-xs text-gray-500">{candidate.reason}</div></td>
              <td className="px-4 py-3">{candidate.suggestedType}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-500">{candidate.projectId}</td>
              <td className="px-4 py-3 tabular-nums">{Math.round(candidate.confidence * 100)}%</td>
              <td className="px-4 py-3">{candidate.source}</td>
              <td className="px-4 py-3"><CandidateStatusBadge status={candidate.status} /></td>
              <td className="px-4 py-3 text-gray-500">{formatDate(candidate.createdAt)}</td>
              <td className="px-4 py-3 text-right"><Button type="button" variant="ghost" onClick={() => setSelected(candidate)}>详情</Button></td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <AdminPagination page={page} pageSize={pageSize} total={total} loading={loading} onPageChange={setPage} />
      <CandidateDrawer
        candidate={selected}
        knowledgeItems={knowledgeItems}
        reviewComment={reviewComment}
        targetKnowledgeItemId={targetKnowledgeItemId}
        submitting={submitting}
        onCommentChange={setReviewComment}
        onTargetChange={setTargetKnowledgeItemId}
        onClose={() => setSelected(null)}
        onApprove={approve}
        onReject={reject}
        onMerge={merge}
      />
    </AdminShell>
  );
}

function KnowledgeItemModal({ open, editing, form, submitting, onChange, onClose, onSubmit }: {
  open: boolean;
  editing: KnowledgeItem | null;
  form: ItemForm;
  submitting: boolean;
  onChange: (form: ItemForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal open={open} title={editing ? "编辑知识" : "新建知识"} onClose={onClose} footer={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button form="knowledge-item-form" type="submit" disabled={submitting}>保存</Button></>}>
      <form id="knowledge-item-form" className="space-y-4" onSubmit={onSubmit}>
        <FormControl label="标题"><TextInput value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} /></FormControl>
        <FormControl label="内容"><TextArea value={form.content} onChange={(event) => onChange({ ...form, content: event.target.value })} /></FormControl>
        <FormControl label="摘要"><TextInput value={form.summary} onChange={(event) => onChange({ ...form, summary: event.target.value })} /></FormControl>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormControl label="类型"><Select value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value })} className="w-full">{knowledgeTypes.map((item) => <option key={item} value={item}>{item}</option>)}</Select></FormControl>
          <FormControl label="状态"><Select value={form.status} onChange={(event) => onChange({ ...form, status: event.target.value })} className="w-full">{knowledgeStatuses.map((item) => <option key={item} value={item}>{item}</option>)}</Select></FormControl>
          <FormControl label="范围"><Select value={form.scope} onChange={(event) => onChange({ ...form, scope: event.target.value })} className="w-full"><option value="global">global</option><option value="project">project</option></Select></FormControl>
          <FormControl label="优先级"><Select value={form.priority} onChange={(event) => onChange({ ...form, priority: event.target.value })} className="w-full"><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></Select></FormControl>
        </div>
        <FormControl label="标签"><TextInput value={form.tags} onChange={(event) => onChange({ ...form, tags: event.target.value })} /></FormControl>
      </form>
    </Modal>
  );
}

function CandidateDrawer({
  candidate,
  knowledgeItems,
  reviewComment,
  targetKnowledgeItemId,
  submitting,
  onCommentChange,
  onTargetChange,
  onClose,
  onApprove,
  onReject,
  onMerge,
}: {
  candidate: KnowledgeCandidate | null;
  knowledgeItems: KnowledgeItem[];
  reviewComment: string;
  targetKnowledgeItemId: string;
  submitting: boolean;
  onCommentChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onClose: () => void;
  onApprove: (candidate: KnowledgeCandidate) => Promise<void>;
  onReject: (candidate: KnowledgeCandidate) => Promise<void>;
  onMerge: (candidate: KnowledgeCandidate) => Promise<void>;
}) {
  return (
    <AdminDrawer open={Boolean(candidate)} title={candidate?.title ?? "候选详情"} onClose={onClose}>
      {candidate ? (
        <div className="space-y-5">
          <DetailGrid>
            <DetailItem label="建议类型" value={candidate.suggestedType} />
            <DetailItem label="状态" value={<CandidateStatusBadge status={candidate.status} />} />
            <DetailItem label="置信度" value={`${Math.round(candidate.confidence * 100)}%`} />
            <DetailItem label="来源" value={candidate.source} />
            <DetailItem label="项目 ID" value={candidate.projectId} />
            <DetailItem label="来源路径" value={candidate.sourcePath ?? "-"} />
          </DetailGrid>
          <Section title="候选内容"><div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm leading-6 text-gray-800">{candidate.content}</div></Section>
          <Section title="抽取原因"><div className="text-sm leading-6 text-gray-700">{candidate.reason}</div></Section>
          {candidate.status === "pending" ? (
            <Section title="审核操作">
              <div className="space-y-3">
                <TextArea value={reviewComment} onChange={(event) => onCommentChange(event.target.value)} placeholder="审核备注" />
                <Select value={targetKnowledgeItemId} onChange={(event) => onTargetChange(event.target.value)} className="w-full">
                  {knowledgeItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                </Select>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={submitting} onClick={() => void onApprove(candidate)}>通过</Button>
                  <Button type="button" variant="secondary" disabled={submitting} onClick={() => void onMerge(candidate)}>合并</Button>
                  <Button type="button" variant="danger" disabled={submitting} onClick={() => void onReject(candidate)}>拒绝</Button>
                </div>
              </div>
            </Section>
          ) : null}
        </div>
      ) : null}
    </AdminDrawer>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return <div className="mb-5"><h2 className="text-xl font-semibold text-gray-950">{title}</h2><p className="mt-2 text-sm text-gray-500">{subtitle}</p></div>;
}

function Feedback({ notice, error }: { notice?: string | null; error?: string | null }) {
  return <>{notice ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}{error ? <div className="mt-4"><InlineError message={error} /></div> : null}</>;
}

function FormControl({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><FieldLabel>{label}</FieldLabel>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="mb-3 text-sm font-semibold text-gray-950">{title}</h3>{children}</section>;
}

function KnowledgeStatusBadge({ status }: { status: string }) {
  const tone = status === "active" ? "green" : status === "disabled" ? "gray" : status === "archived" ? "amber" : "blue";
  return <AdminStatusBadge label={status} tone={tone} />;
}

function CandidateStatusBadge({ status }: { status: string }) {
  const tone = status === "approved" || status === "merged" ? "green" : status === "rejected" ? "red" : "amber";
  return <AdminStatusBadge label={status} tone={tone} />;
}

function defaultItemForm(): ItemForm {
  return {
    title: "",
    content: "",
    summary: "",
    type: "default_rule",
    status: "active",
    scope: "global",
    tags: "",
    priority: "medium",
  };
}

function splitTags(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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

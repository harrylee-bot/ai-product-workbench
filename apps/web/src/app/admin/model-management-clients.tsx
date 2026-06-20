"use client";

import { Plus, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AdminShell } from "@/components/admin-shell";
import { AdminFilterBar, AdminStatusBadge, AdminTable, EmptyRow, LoadingRows } from "@/components/admin-ui";
import { Modal } from "@/components/modal";
import { Button, FieldLabel, InlineError, Select, TextInput } from "@/components/ui";
import { apiRequest } from "@/lib/api";
import type { ModelConfigItem, ModelProviderItem, ModelTaskProfileItem } from "@/lib/types";

type ItemsResponse<T> = { items: T[] };

type ProviderForm = {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: string;
  isDefault: boolean;
};

type ConfigForm = {
  providerId: string;
  displayName: string;
  modelName: string;
  contextWindow: string;
  maxOutputTokens: string;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  supportsMultimodal: boolean;
  defaultTemperature: string;
  defaultMaxTokens: string;
  isEnabled: boolean;
};

const taskTypes = [
  "intent_detection",
  "knowledge_classification",
  "requirement_analysis",
  "product_design",
  "prd_generation",
  "prototype_design",
  "prototype_code_generation",
  "patch_planning",
  "qa_check",
  "knowledge_extraction",
  "general_chat",
];

export function AdminModelProvidersClient() {
  const [items, setItems] = useState<ModelProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelProviderItem | null>(null);
  const [form, setForm] = useState<ProviderForm>(defaultProviderForm());
  const [submitting, setSubmitting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<ItemsResponse<ModelProviderItem>>("/admin/model-providers");
      setItems(result.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "模型供应商加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  function openCreate() {
    setEditing(null);
    setForm(defaultProviderForm());
  }

  function openEdit(provider: ModelProviderItem) {
    setEditing(provider);
    setForm({
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      timeoutMs: String(provider.timeoutMs),
      isDefault: provider.isDefault,
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        timeoutMs: toNumber(form.timeoutMs),
        isDefault: form.isDefault,
      };
      if (editing) {
        await apiRequest<ModelProviderItem>(`/admin/model-providers/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setNotice("供应商已保存");
      } else {
        await apiRequest<ModelProviderItem>("/admin/model-providers", {
          method: "POST",
          body: JSON.stringify({ ...payload, apiKey: form.apiKey.trim() }),
        });
        setNotice("供应商已创建");
      }
      setEditing(null);
      setForm(defaultProviderForm());
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(provider: ModelProviderItem) {
    setSubmitting(true);
    try {
      await apiRequest(`/admin/model-providers/${provider.id}/${provider.isEnabled ? "disable" : "enable"}`, {
        method: "POST",
      });
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell title="模型供应商" actions={<Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />新增供应商</Button>}>
      <Header title="模型供应商" subtitle="OpenAI Compatible 供应商配置与 API Key 脱敏展示" />
      <AdminFilterBar>
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      <Feedback notice={notice} error={error} />
      <div className="mt-4">
        <AdminTable columns={["供应商名称", "类型", "Base URL", "API Key", "默认", "状态", "超时", "创建时间", "操作"]} minWidth={1120}>
          {loading ? <LoadingRows columns={9} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={9} label="暂无供应商" /> : null}
          {!loading ? items.map((provider) => (
            <tr key={provider.id} className="hover:bg-gray-50/70">
              <td className="px-4 py-3 font-medium text-gray-950">{provider.name}</td>
              <td className="px-4 py-3 text-gray-500">{provider.type}</td>
              <td className="px-4 py-3 text-gray-500">{provider.baseUrl}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-600">{provider.apiKeyMasked ?? "****"}</td>
              <td className="px-4 py-3">{provider.isDefault ? <AdminStatusBadge label="默认" tone="blue" /> : "-"}</td>
              <td className="px-4 py-3"><EnabledBadge enabled={provider.isEnabled} /></td>
              <td className="px-4 py-3 tabular-nums">{provider.timeoutMs}ms</td>
              <td className="px-4 py-3 text-gray-500">{formatDate(provider.createdAt)}</td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => openEdit(provider)}>编辑</Button>
                  <Button type="button" variant="ghost" disabled={submitting} onClick={() => void toggle(provider)}>
                    {provider.isEnabled ? "禁用" : "启用"}
                  </Button>
                </div>
              </td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <ProviderModal
        open={Boolean(editing) || form.name !== "" || form.baseUrl !== "" || form.apiKey !== ""}
        editing={editing}
        form={form}
        submitting={submitting}
        onChange={setForm}
        onClose={() => {
          setEditing(null);
          setForm(defaultProviderForm());
        }}
        onSubmit={submit}
      />
    </AdminShell>
  );
}

export function AdminModelConfigsClient() {
  const [providers, setProviders] = useState<ModelProviderItem[]>([]);
  const [items, setItems] = useState<ModelConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelConfigItem | null>(null);
  const [form, setForm] = useState<ConfigForm>(defaultConfigForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providerResult, configResult] = await Promise.all([
        apiRequest<ItemsResponse<ModelProviderItem>>("/admin/model-providers"),
        apiRequest<ItemsResponse<ModelConfigItem>>("/admin/model-configs"),
      ]);
      setProviders(providerResult.items);
      setItems(configResult.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "模型配置加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  function openCreate() {
    setEditing(null);
    setForm({ ...defaultConfigForm(), providerId: providers[0]?.id ?? "" });
    setModalOpen(true);
  }

  function openEdit(config: ModelConfigItem) {
    setEditing(config);
    setForm({
      providerId: config.providerId,
      displayName: config.displayName,
      modelName: config.modelName,
      contextWindow: String(config.contextWindow ?? ""),
      maxOutputTokens: String(config.maxOutputTokens ?? ""),
      supportsStreaming: config.supportsStreaming,
      supportsJsonMode: config.supportsJsonMode,
      supportsMultimodal: config.supportsMultimodal,
      defaultTemperature: String(config.defaultTemperature),
      defaultMaxTokens: String(config.defaultMaxTokens ?? ""),
      isEnabled: config.isEnabled,
    });
    setModalOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const payload = {
      providerId: form.providerId,
      displayName: form.displayName.trim(),
      modelName: form.modelName.trim(),
      contextWindow: toNumber(form.contextWindow),
      maxOutputTokens: toNumber(form.maxOutputTokens),
      supportsStreaming: form.supportsStreaming,
      supportsJsonMode: form.supportsJsonMode,
      supportsMultimodal: form.supportsMultimodal,
      defaultTemperature: toNumber(form.defaultTemperature) ?? 0.2,
      defaultMaxTokens: toNumber(form.defaultMaxTokens),
      isEnabled: form.isEnabled,
    };
    try {
      if (editing) {
        await apiRequest<ModelConfigItem>(`/admin/model-configs/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setNotice("模型配置已保存");
      } else {
        await apiRequest<ModelConfigItem>("/admin/model-configs", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setNotice("模型配置已创建");
      }
      setModalOpen(false);
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminShell title="模型配置" actions={<Button type="button" onClick={openCreate}><Plus className="h-4 w-4" />新增模型</Button>}>
      <Header title="模型配置" subtitle="模型能力、默认参数和可用状态" />
      <AdminFilterBar>
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      <Feedback notice={notice} error={error} />
      <div className="mt-4">
        <AdminTable columns={["显示名", "模型名称", "供应商", "流式", "JSON", "多模态", "Temperature", "Max Tokens", "状态", "操作"]} minWidth={1120}>
          {loading ? <LoadingRows columns={10} /> : null}
          {!loading && items.length === 0 ? <EmptyRow columns={10} label="暂无模型配置" /> : null}
          {!loading ? items.map((config) => (
            <tr key={config.id} className="hover:bg-gray-50/70">
              <td className="px-4 py-3 font-medium text-gray-950">{config.displayName}</td>
              <td className="px-4 py-3 font-mono text-xs text-gray-600">{config.modelName}</td>
              <td className="px-4 py-3">{config.providerName ?? "-"}</td>
              <td className="px-4 py-3"><BooleanBadge value={config.supportsStreaming} /></td>
              <td className="px-4 py-3"><BooleanBadge value={config.supportsJsonMode} /></td>
              <td className="px-4 py-3"><BooleanBadge value={config.supportsMultimodal} /></td>
              <td className="px-4 py-3 tabular-nums">{config.defaultTemperature}</td>
              <td className="px-4 py-3 tabular-nums">{config.defaultMaxTokens ?? "-"}</td>
              <td className="px-4 py-3"><EnabledBadge enabled={config.isEnabled} /></td>
              <td className="px-4 py-3 text-right">
                <Button type="button" variant="ghost" onClick={() => openEdit(config)}>编辑</Button>
              </td>
            </tr>
          )) : null}
        </AdminTable>
      </div>
      <ConfigModal
        open={modalOpen}
        editing={editing}
        providers={providers}
        form={form}
        submitting={submitting}
        onChange={setForm}
        onClose={() => setModalOpen(false)}
        onSubmit={submit}
      />
    </AdminShell>
  );
}

export function AdminModelTaskProfilesClient() {
  const [configs, setConfigs] = useState<ModelConfigItem[]>([]);
  const [profiles, setProfiles] = useState<ModelTaskProfileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingTask, setSavingTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const profileByTask = useMemo(() => new Map(profiles.map((profile) => [profile.taskType, profile])), [profiles]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configResult, profileResult] = await Promise.all([
        apiRequest<ItemsResponse<ModelConfigItem>>("/admin/model-configs"),
        apiRequest<ItemsResponse<ModelTaskProfileItem>>("/admin/model-task-profiles"),
      ]);
      setConfigs(configResult.items);
      setProfiles(profileResult.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "任务模型映射加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function saveTask(taskType: string, profile: Partial<ModelTaskProfileItem>, override: Partial<ModelTaskProfileItem> = {}) {
    const modelConfigId = String(override.modelConfigId ?? profile.modelConfigId ?? configs[0]?.id ?? "");
    if (!modelConfigId) {
      setError("请先创建模型配置");
      return;
    }
    setSavingTask(taskType);
    setError(null);
    try {
      await apiRequest<ModelTaskProfileItem>(`/admin/model-task-profiles/${taskType}`, {
        method: "PUT",
        body: JSON.stringify({
          modelConfigId,
          temperature: override.temperature ?? profile.temperature ?? undefined,
          maxTokens: override.maxTokens ?? profile.maxTokens ?? undefined,
          responseFormat: override.responseFormat ?? profile.responseFormat ?? "text",
          retryCount: override.retryCount ?? profile.retryCount ?? 1,
          timeoutMs: override.timeoutMs ?? profile.timeoutMs ?? undefined,
          isEnabled: override.isEnabled ?? profile.isEnabled ?? true,
        }),
      });
      setNotice("任务映射已保存");
      await loadItems();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "保存失败");
    } finally {
      setSavingTask(null);
    }
  }

  return (
    <AdminShell title="任务模型映射">
      <Header title="任务模型映射" subtitle="每类 AI 任务使用的模型与响应格式" />
      <AdminFilterBar>
        <Button type="button" variant="ghost" onClick={() => void loadItems()}><RotateCcw className="h-4 w-4" />刷新</Button>
      </AdminFilterBar>
      <Feedback notice={notice} error={error} />
      <div className="mt-4">
        <AdminTable columns={["任务类型", "使用模型", "供应商", "温度", "Max Tokens", "格式", "状态", "操作"]} minWidth={1100}>
          {loading ? <LoadingRows columns={8} /> : null}
          {!loading ? taskTypes.map((taskType) => {
            const profile = profileByTask.get(taskType);
            return (
              <TaskProfileRow
                key={taskType}
                taskType={taskType}
                profile={profile}
                configs={configs}
                saving={savingTask === taskType}
                onSave={saveTask}
              />
            );
          }) : null}
        </AdminTable>
      </div>
    </AdminShell>
  );
}

function TaskProfileRow({
  taskType,
  profile,
  configs,
  saving,
  onSave,
}: {
  taskType: string;
  profile?: ModelTaskProfileItem;
  configs: ModelConfigItem[];
  saving: boolean;
  onSave: (taskType: string, profile: Partial<ModelTaskProfileItem>, override?: Partial<ModelTaskProfileItem>) => Promise<void>;
}) {
  const [modelConfigId, setModelConfigId] = useState(profile?.modelConfigId ?? configs[0]?.id ?? "");
  const [temperature, setTemperature] = useState(String(profile?.temperature ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(profile?.maxTokens ?? ""));
  const [responseFormat, setResponseFormat] = useState(profile?.responseFormat ?? "text");
  const [isEnabled, setIsEnabled] = useState(profile?.isEnabled ?? true);
  const selected = configs.find((config) => config.id === modelConfigId);

  useEffect(() => {
    setModelConfigId(profile?.modelConfigId ?? configs[0]?.id ?? "");
    setTemperature(String(profile?.temperature ?? ""));
    setMaxTokens(String(profile?.maxTokens ?? ""));
    setResponseFormat(profile?.responseFormat ?? "text");
    setIsEnabled(profile?.isEnabled ?? true);
  }, [configs, profile]);

  return (
    <tr className="hover:bg-gray-50/70">
      <td className="px-4 py-3 font-medium text-gray-950">{taskType}</td>
      <td className="px-4 py-3">
        <Select value={modelConfigId} onChange={(event) => setModelConfigId(event.target.value)} className="w-[220px]">
          {configs.map((config) => (
            <option key={config.id} value={config.id}>{config.displayName}</option>
          ))}
        </Select>
      </td>
      <td className="px-4 py-3 text-gray-500">{selected?.providerName ?? profile?.providerName ?? "-"}</td>
      <td className="px-4 py-3">
        <TextInput value={temperature} onChange={(event) => setTemperature(event.target.value)} className="h-9 w-[80px]" />
      </td>
      <td className="px-4 py-3">
        <TextInput value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} className="h-9 w-[100px]" />
      </td>
      <td className="px-4 py-3">
        <Select value={responseFormat} onChange={(event) => setResponseFormat(event.target.value)}>
          <option value="text">text</option>
          <option value="json">json</option>
        </Select>
      </td>
      <td className="px-4 py-3">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} />
          启用
        </label>
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={() => void onSave(taskType, profile ?? {}, {
            modelConfigId,
            temperature: toNumber(temperature),
            maxTokens: toNumber(maxTokens),
            responseFormat,
            isEnabled,
          })}
        >
          <Save className="h-4 w-4" />
          保存
        </Button>
      </td>
    </tr>
  );
}

function ProviderModal({
  open,
  editing,
  form,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: ModelProviderItem | null;
  form: ProviderForm;
  submitting: boolean;
  onChange: (form: ProviderForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal
      open={open}
      title={editing ? "编辑供应商" : "新增供应商"}
      onClose={onClose}
      footer={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button form="provider-form" type="submit" disabled={submitting}>保存</Button></>}
    >
      <form id="provider-form" className="space-y-4" onSubmit={onSubmit}>
        <FormControl label="供应商名称"><TextInput value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></FormControl>
        <FormControl label="Base URL"><TextInput value={form.baseUrl} onChange={(event) => onChange({ ...form, baseUrl: event.target.value })} /></FormControl>
        <FormControl label={editing ? "API Key（留空不更新）" : "API Key"}><TextInput type="password" value={form.apiKey} onChange={(event) => onChange({ ...form, apiKey: event.target.value })} /></FormControl>
        <FormControl label="超时时间 ms"><TextInput value={form.timeoutMs} onChange={(event) => onChange({ ...form, timeoutMs: event.target.value })} /></FormControl>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={form.isDefault} onChange={(event) => onChange({ ...form, isDefault: event.target.checked })} />
          设为默认供应商
        </label>
      </form>
    </Modal>
  );
}

function ConfigModal({
  open,
  editing,
  providers,
  form,
  submitting,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: ModelConfigItem | null;
  providers: ModelProviderItem[];
  form: ConfigForm;
  submitting: boolean;
  onChange: (form: ConfigForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Modal
      open={open}
      title={editing ? "编辑模型配置" : "新增模型配置"}
      onClose={onClose}
      footer={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button form="config-form" type="submit" disabled={submitting}>保存</Button></>}
    >
      <form id="config-form" className="space-y-4" onSubmit={onSubmit}>
        <FormControl label="供应商">
          <Select value={form.providerId} onChange={(event) => onChange({ ...form, providerId: event.target.value })} className="w-full">
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </Select>
        </FormControl>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormControl label="显示名称"><TextInput value={form.displayName} onChange={(event) => onChange({ ...form, displayName: event.target.value })} /></FormControl>
          <FormControl label="模型名称"><TextInput value={form.modelName} onChange={(event) => onChange({ ...form, modelName: event.target.value })} /></FormControl>
          <FormControl label="Context Window"><TextInput value={form.contextWindow} onChange={(event) => onChange({ ...form, contextWindow: event.target.value })} /></FormControl>
          <FormControl label="Max Output Tokens"><TextInput value={form.maxOutputTokens} onChange={(event) => onChange({ ...form, maxOutputTokens: event.target.value })} /></FormControl>
          <FormControl label="Temperature"><TextInput value={form.defaultTemperature} onChange={(event) => onChange({ ...form, defaultTemperature: event.target.value })} /></FormControl>
          <FormControl label="Default Max Tokens"><TextInput value={form.defaultMaxTokens} onChange={(event) => onChange({ ...form, defaultMaxTokens: event.target.value })} /></FormControl>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Check label="支持流式" checked={form.supportsStreaming} onChange={(value) => onChange({ ...form, supportsStreaming: value })} />
          <Check label="支持 JSON" checked={form.supportsJsonMode} onChange={(value) => onChange({ ...form, supportsJsonMode: value })} />
          <Check label="支持多模态" checked={form.supportsMultimodal} onChange={(value) => onChange({ ...form, supportsMultimodal: value })} />
          <Check label="启用" checked={form.isEnabled} onChange={(value) => onChange({ ...form, isEnabled: value })} />
        </div>
      </form>
    </Modal>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold text-gray-950">{title}</h2>
      <p className="mt-2 text-sm text-gray-500">{subtitle}</p>
    </div>
  );
}

function Feedback({ notice, error }: { notice?: string | null; error?: string | null }) {
  return (
    <>
      {notice ? <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}
      {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
    </>
  );
}

function FormControl({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><FieldLabel>{label}</FieldLabel>{children}</div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <AdminStatusBadge label={enabled ? "启用" : "禁用"} tone={enabled ? "green" : "gray"} />;
}

function BooleanBadge({ value }: { value: boolean }) {
  return <AdminStatusBadge label={value ? "是" : "否"} tone={value ? "blue" : "gray"} />;
}

function defaultProviderForm(): ProviderForm {
  return { name: "", baseUrl: "", apiKey: "", timeoutMs: "60000", isDefault: false };
}

function defaultConfigForm(): ConfigForm {
  return {
    providerId: "",
    displayName: "",
    modelName: "",
    contextWindow: "",
    maxOutputTokens: "",
    supportsStreaming: true,
    supportsJsonMode: false,
    supportsMultimodal: false,
    defaultTemperature: "0.2",
    defaultMaxTokens: "",
    isEnabled: true,
  };
}

function toNumber(value: string | number | null | undefined) {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

"use client";

import {
  ActivityIcon,
  ArrowLeftIcon,
  BrainIcon,
  CheckIcon,
  DatabaseIcon,
  FolderKanbanIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast, Toaster } from "sonner";
import useSWR from "swr";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  approveKnowledgeCandidate,
  createAdminUser,
  getAdminDashboardStats,
  getAdminProjects,
  getAdminUsers,
  getAuditLogs,
  getDeerflowSkills,
  getFileParses,
  getKnowledgeCandidates,
  getKnowledgeItems,
  getKnowledgeVaultStatus,
  getModelCalls,
  getModelConfigs,
  getModelProviders,
  getModelTaskProfiles,
  getQaReports,
  getRuntimeRuns,
  getSystemHealth,
  rejectKnowledgeCandidate,
  resetAdminUserPassword,
  setAdminUserEnabled,
  setKnowledgeItemEnabled,
  setModelProviderEnabled,
  syncKnowledgeVault,
  updateAdminUser,
  updateDeerflowSkill,
  updateModelConfig,
  type AdminProject,
  type AdminUser,
  type AuditLog,
  type DeerflowSkill,
  type FileParseLog,
  type KnowledgeCandidate,
  type KnowledgeItem,
  type ModelCallLog,
  type ModelConfig,
  type ModelProvider,
  type ModelTaskProfile,
  type PageResponse,
  type QaReportLog,
  type RuntimeRunLog,
} from "@/lib/api/admin-client";
import { useAuth } from "@/lib/auth/nest-auth";
import { cn } from "@/lib/utils";

type AdminSection =
  | "overview"
  | "users"
  | "projects"
  | "models"
  | "knowledge"
  | "runtime"
  | "audit";

type Column<T> = {
  header: string;
  className?: string;
  cell: (row: T) => React.ReactNode;
};

const PAGE_SIZE = 12;

const sections: Array<{
  id: AdminSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "overview", label: "总览", icon: LayoutDashboardIcon },
  { id: "users", label: "用户", icon: UsersIcon },
  { id: "projects", label: "项目", icon: FolderKanbanIcon },
  { id: "models", label: "模型与 Skill", icon: BrainIcon },
  { id: "knowledge", label: "知识库", icon: DatabaseIcon },
  { id: "runtime", label: "运行日志", icon: ActivityIcon },
  { id: "audit", label: "审计", icon: ShieldCheckIcon },
];

export function AdminConsole() {
  const router = useRouter();
  const { user, loading, refresh } = useAuth();
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [authRefreshed, setAuthRefreshed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    refresh().finally(() => {
      if (!cancelled) setAuthRefreshed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const authLoading = loading || !authRefreshed;

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [authLoading, router, user]);

  if (authLoading || !user) {
    return <AdminScreenState title="正在加载系统设置" />;
  }

  if (user.role !== "admin") {
    return (
      <AdminScreenState
        title="无权访问"
        description="当前账号不是管理员，请使用管理员账号登录。"
      />
    );
  }

  const ActiveIcon =
    sections.find((section) => section.id === activeSection)?.icon ??
    LayoutDashboardIcon;

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <Toaster position="top-center" theme="system" />
      <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="border-border/70 border-b bg-sidebar/80 lg:border-r lg:border-b-0">
          <div className="flex h-full flex-col">
            <div className="border-border/70 border-b px-4 py-4">
              <Button asChild className="mb-4" size="sm" variant="outline">
                <Link href="/">
                  <ArrowLeftIcon className="size-4" />
                  返回工作台
                </Link>
              </Button>
              <div className="flex items-center gap-3">
                <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
                  <ServerIcon className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">系统设置</div>
                  <div className="text-muted-foreground truncate text-xs">
                    {user.displayName || user.username}
                  </div>
                </div>
              </div>
            </div>
            <nav className="grid gap-1 p-3">
              {sections.map(({ id, label, icon: Icon }) => (
                <Button
                  className={cn("justify-start", activeSection === id && "bg-muted")}
                  key={id}
                  onClick={() => setActiveSection(id)}
                  variant={activeSection === id ? "secondary" : "ghost"}
                >
                  <Icon className="size-4" />
                  {label}
                </Button>
              ))}
            </nav>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="border-border/70 flex items-center justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ActiveIcon className="text-muted-foreground size-4" />
                <h1 className="truncate text-lg font-semibold">
                  {sections.find((section) => section.id === activeSection)?.label}
                </h1>
              </div>
              <p className="text-muted-foreground mt-1 text-sm">
                管理用户、模型、知识、运行记录与 DeerFlow 扩展能力。
              </p>
            </div>
            <StatusPill label="Admin" value="已登录" />
          </header>

          <div className="mx-auto w-full max-w-7xl space-y-6 px-5 py-5">
            {activeSection === "overview" && <OverviewSection />}
            {activeSection === "users" && <UsersSection />}
            {activeSection === "projects" && <ProjectsSection />}
            {activeSection === "models" && <ModelsSection />}
            {activeSection === "knowledge" && <KnowledgeSection />}
            {activeSection === "runtime" && <RuntimeSection />}
            {activeSection === "audit" && <AuditSection />}
          </div>
        </section>
      </div>
    </main>
  );
}

function OverviewSection() {
  const stats = useSWR("admin-dashboard-stats", getAdminDashboardStats);
  const health = useSWR("system-health", getSystemHealth);
  const skills = useSWR("deerflow-skills-overview", getDeerflowSkills);

  const skillItems = skills.data?.skills ?? [];
  const customSkillCount = skillItems.filter((skill) => skill.category === "custom").length;

  return (
    <div className="space-y-5">
      <MetricGrid>
        <MetricTile
          icon={UsersIcon}
          label="用户总数"
          loading={stats.isLoading}
          value={stats.data?.userCount}
        />
        <MetricTile
          icon={FolderKanbanIcon}
          label="项目总数"
          loading={stats.isLoading}
          value={stats.data?.projectCount}
        />
        <MetricTile
          icon={ActivityIcon}
          label="今日运行"
          loading={stats.isLoading}
          value={stats.data?.todayRuntimeRunCount}
        />
        <MetricTile
          icon={GaugeIcon}
          label="今日模型调用"
          loading={stats.isLoading}
          tone={stats.data?.todayFailedModelCallCount ? "warning" : "default"}
          value={stats.data?.todayModelCallCount}
          detail={
            stats.data
              ? `${stats.data.todayFailedModelCallCount} 次失败`
              : undefined
          }
        />
        <MetricTile
          icon={DatabaseIcon}
          label="待审核知识"
          loading={stats.isLoading}
          tone={stats.data?.pendingKnowledgeCandidateCount ? "warning" : "default"}
          value={stats.data?.pendingKnowledgeCandidateCount}
        />
        <MetricTile
          icon={SparklesIcon}
          label="DeerFlow Skill"
          loading={skills.isLoading}
          value={skillItems.length}
          detail={`${customSkillCount} 个自定义`}
        />
      </MetricGrid>

      <SectionPanel
        description="API 服务、DeerFlow 开关和当前启用模块。"
        title="系统健康"
      >
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-3">
            <StatusPill
              label="API"
              value={health.data?.ok ? "正常" : "未知"}
              variant={health.data?.ok ? "default" : "outline"}
            />
            <StatusPill
              label="DeerFlow"
              value={health.data?.deerflow.enabled ? "已启用" : "未启用"}
              variant={health.data?.deerflow.enabled ? "default" : "destructive"}
            />
            <div className="text-muted-foreground text-sm">
              阶段：{health.data?.phase ?? "读取中"}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(health.data?.modules ?? []).map((module) => (
              <Badge key={module} variant="outline">
                {module}
              </Badge>
            ))}
            {health.isLoading && <MutedText>正在读取模块列表...</MutedText>}
            {health.error && <ErrorText error={health.error} />}
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}

function UsersSection() {
  const [keyword, setKeyword] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const query = useMemo(
    () => ({
      pageSize: PAGE_SIZE,
      keyword,
      role: role === "all" ? undefined : role,
      status: status === "all" ? undefined : status,
    }),
    [keyword, role, status],
  );
  const users = useSWR(["admin-users", query], () => getAdminUsers(query));

  const columns: Column<AdminUser>[] = [
    {
      header: "用户",
      cell: (row) => (
        <div>
          <div className="font-medium">{row.displayName}</div>
          <div className="text-muted-foreground text-xs">
            {row.username}
            {row.email ? ` · ${row.email}` : ""}
          </div>
        </div>
      ),
    },
    {
      header: "角色",
      className: "w-[140px]",
      cell: (row) => <UserRoleSelect user={row} onChanged={users.mutate} />,
    },
    {
      header: "状态",
      className: "w-[150px]",
      cell: (row) => <UserStatusSwitch user={row} onChanged={users.mutate} />,
    },
    {
      header: "最后登录",
      className: "w-[180px]",
      cell: (row) => formatDate(row.lastLoginAt),
    },
    {
      header: "操作",
      className: "w-[140px]",
      cell: (row) => <ResetPasswordButton user={row} />,
    },
  ];

  return (
    <SectionPanel
      actions={
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <PlusIcon className="size-4" />
          新建用户
        </Button>
      }
      description="创建账号、切换角色、启停用户与重置密码。"
      title="用户管理"
    >
      <Toolbar>
        <SearchInput
          onChange={setKeyword}
          placeholder="搜索用户名或邮箱"
          value={keyword}
        />
        <Select value={role} onValueChange={setRole}>
          <SelectTrigger size="sm">
            <SelectValue placeholder="角色" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部角色</SelectItem>
            <SelectItem value="admin">管理员</SelectItem>
            <SelectItem value="user">普通用户</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">启用</SelectItem>
            <SelectItem value="disabled">停用</SelectItem>
          </SelectContent>
        </Select>
      </Toolbar>
      <AdminTable
        columns={columns}
        emptyText="暂无用户"
        error={users.error}
        getRowKey={(row) => row.id}
        loading={users.isLoading}
        rows={users.data?.items}
      />
      <PaginationSummary data={users.data} />
      <CreateUserDialog
        onCreated={() => void users.mutate()}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />
    </SectionPanel>
  );
}

function ProjectsSection() {
  const [keyword, setKeyword] = useState("");
  const projects = useSWR(["admin-projects", keyword], () =>
    getAdminProjects({ pageSize: PAGE_SIZE, keyword }),
  );

  const columns: Column<AdminProject>[] = [
    {
      header: "项目",
      cell: (row) => (
        <div>
          <div className="max-w-[320px] truncate font-medium">{row.title}</div>
          <div className="text-muted-foreground max-w-[420px] truncate text-xs">
            {row.description || row.id}
          </div>
        </div>
      ),
    },
    {
      header: "状态",
      className: "w-[130px]",
      cell: (row) => <StatusBadge value={row.status} />,
    },
    {
      header: "负责人",
      className: "w-[180px]",
      cell: (row) => row.ownerDisplayName || row.ownerUsername,
    },
    {
      header: "数据",
      className: "w-[220px]",
      cell: (row) =>
        `${row.conversationCount} 对话 · ${row.runtimeRunCount} 运行 · ${row.fileCount} 文件`,
    },
    {
      header: "最近活动",
      className: "w-[180px]",
      cell: (row) => formatDate(row.lastActivityAt),
    },
  ];

  return (
    <SectionPanel description="查看线上项目、负责人和最近活动。" title="项目">
      <Toolbar>
        <SearchInput
          onChange={setKeyword}
          placeholder="搜索项目名称或描述"
          value={keyword}
        />
      </Toolbar>
      <AdminTable
        columns={columns}
        emptyText="暂无项目"
        error={projects.error}
        getRowKey={(row) => row.id}
        loading={projects.isLoading}
        rows={projects.data?.items}
      />
      <PaginationSummary data={projects.data} />
    </SectionPanel>
  );
}

function ModelsSection() {
  const [tab, setTab] = useState("providers");
  const providers = useSWR("model-providers", getModelProviders);
  const configs = useSWR("model-configs", getModelConfigs);
  const profiles = useSWR("model-task-profiles", getModelTaskProfiles);
  const skills = useSWR("deerflow-skills", getDeerflowSkills);

  return (
    <SectionPanel
      description="管理模型供应商、模型配置、任务路由和 DeerFlow Skills。"
      title="模型与 Skill"
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="providers">供应商</TabsTrigger>
          <TabsTrigger value="configs">模型</TabsTrigger>
          <TabsTrigger value="profiles">任务路由</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "providers" && (
        <ProvidersTable data={providers.data?.items} error={providers.error} loading={providers.isLoading} mutate={providers.mutate} />
      )}
      {tab === "configs" && (
        <ModelConfigsTable data={configs.data?.items} error={configs.error} loading={configs.isLoading} mutate={configs.mutate} />
      )}
      {tab === "profiles" && (
        <TaskProfilesTable data={profiles.data?.items} error={profiles.error} loading={profiles.isLoading} />
      )}
      {tab === "skills" && (
        <SkillsTable data={skills.data?.skills} error={skills.error} loading={skills.isLoading} mutate={skills.mutate} />
      )}
    </SectionPanel>
  );
}

function KnowledgeSection() {
  const [tab, setTab] = useState("items");
  const vault = useSWR("knowledge-vault", getKnowledgeVaultStatus);
  const items = useSWR("knowledge-items", () => getKnowledgeItems({ pageSize: PAGE_SIZE }));
  const candidates = useSWR("knowledge-candidates", () =>
    getKnowledgeCandidates({ pageSize: PAGE_SIZE }),
  );

  const handleSync = async () => {
    try {
      await syncKnowledgeVault();
      toast.success("知识库同步已触发");
      void vault.mutate();
      void items.mutate();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-5">
      <SectionPanel
        actions={
          <Button onClick={handleSync} size="sm" variant="outline">
            <RefreshCwIcon className="size-4" />
            同步
          </Button>
        }
        description="Obsidian vault 状态和知识同步入口。"
        title="知识库状态"
      >
        {vault.error ? (
          <ErrorText error={vault.error} />
        ) : (
          <div className="grid gap-3 md:grid-cols-4">
            {Object.entries(vault.data ?? {}).slice(0, 8).map(([key, value]) => (
              <div className="rounded-lg border p-3" key={key}>
                <div className="text-muted-foreground text-xs">{key}</div>
                <div className="mt-1 truncate text-sm font-medium">
                  {formatUnknown(value)}
                </div>
              </div>
            ))}
            {vault.isLoading && <MutedText>正在读取状态...</MutedText>}
          </div>
        )}
      </SectionPanel>

      <SectionPanel description="启停知识条目，审核运行过程中沉淀的候选知识。" title="知识管理">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="items">知识条目</TabsTrigger>
            <TabsTrigger value="candidates">候选审核</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "items" && (
          <KnowledgeItemsTable data={items.data?.items} error={items.error} loading={items.isLoading} mutate={items.mutate} />
        )}
        {tab === "candidates" && (
          <KnowledgeCandidatesTable data={candidates.data?.items} error={candidates.error} loading={candidates.isLoading} mutate={candidates.mutate} />
        )}
      </SectionPanel>
    </div>
  );
}

function RuntimeSection() {
  const [tab, setTab] = useState("runs");
  const runs = useSWR("runtime-runs", () => getRuntimeRuns({ pageSize: PAGE_SIZE }));
  const modelCalls = useSWR("model-calls", () => getModelCalls({ pageSize: PAGE_SIZE }));
  const files = useSWR("file-parses", () => getFileParses({ pageSize: PAGE_SIZE }));
  const qa = useSWR("qa-reports", () => getQaReports({ pageSize: PAGE_SIZE }));

  return (
    <SectionPanel
      description="排查 DeerFlow 执行链路、模型调用、文件解析和 QA 结果。"
      title="运行日志"
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="runs">运行</TabsTrigger>
          <TabsTrigger value="models">模型调用</TabsTrigger>
          <TabsTrigger value="files">文件解析</TabsTrigger>
          <TabsTrigger value="qa">QA</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "runs" && <RuntimeRunsTable data={runs.data?.items} error={runs.error} loading={runs.isLoading} />}
      {tab === "models" && <ModelCallsTable data={modelCalls.data?.items} error={modelCalls.error} loading={modelCalls.isLoading} />}
      {tab === "files" && <FileParsesTable data={files.data?.items} error={files.error} loading={files.isLoading} />}
      {tab === "qa" && <QaReportsTable data={qa.data?.items} error={qa.error} loading={qa.isLoading} />}
    </SectionPanel>
  );
}

function AuditSection() {
  const logs = useSWR("audit-logs", () => getAuditLogs({ pageSize: PAGE_SIZE }));
  const columns: Column<AuditLog>[] = [
    { header: "时间", className: "w-[180px]", cell: (row) => formatDate(row.createdAt) },
    { header: "管理员", className: "w-[180px]", cell: (row) => row.adminDisplayName || row.adminUsername || row.adminUserId },
    { header: "动作", className: "w-[220px]", cell: (row) => row.action },
    { header: "对象", className: "w-[220px]", cell: (row) => `${row.targetType}${row.targetId ? ` · ${shortId(row.targetId)}` : ""}` },
    { header: "来源", cell: (row) => row.ip || "未知" },
  ];
  return (
    <SectionPanel description="管理员操作记录，用于追溯配置和账号变更。" title="审计日志">
      <AdminTable
        columns={columns}
        emptyText="暂无审计日志"
        error={logs.error}
        getRowKey={(row) => row.id}
        loading={logs.isLoading}
        rows={logs.data?.items}
      />
      <PaginationSummary data={logs.data} />
    </SectionPanel>
  );
}

function ProvidersTable(props: {
  data?: ModelProvider[];
  error?: unknown;
  loading: boolean;
  mutate: () => Promise<unknown>;
}) {
  const columns: Column<ModelProvider>[] = [
    { header: "供应商", cell: (row) => <NameWithSub name={row.name} sub={row.baseUrl} /> },
    { header: "类型", className: "w-[170px]", cell: (row) => row.type },
    { header: "默认", className: "w-[90px]", cell: (row) => row.isDefault ? <Badge>默认</Badge> : <MutedText>否</MutedText> },
    {
      header: "启用",
      className: "w-[100px]",
      cell: (row) => (
        <Switch
          checked={row.isEnabled}
          onCheckedChange={async (checked) => {
            try {
              await setModelProviderEnabled(row.id, checked);
              toast.success(checked ? "已启用供应商" : "已停用供应商");
              void props.mutate();
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        />
      ),
    },
    { header: "更新时间", className: "w-[180px]", cell: (row) => formatDate(row.updatedAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无模型供应商"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function ModelConfigsTable(props: {
  data?: ModelConfig[];
  error?: unknown;
  loading: boolean;
  mutate: () => Promise<unknown>;
}) {
  const columns: Column<ModelConfig>[] = [
    { header: "模型", cell: (row) => <NameWithSub name={row.displayName} sub={row.modelName} /> },
    { header: "供应商", className: "w-[160px]", cell: (row) => row.providerName },
    { header: "能力", className: "w-[240px]", cell: (row) => modelAbilityText(row) },
    {
      header: "启用",
      className: "w-[100px]",
      cell: (row) => (
        <Switch
          checked={row.isEnabled}
          onCheckedChange={async (checked) => {
            try {
              await updateModelConfig(row.id, { isEnabled: checked });
              toast.success(checked ? "已启用模型" : "已停用模型");
              void props.mutate();
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        />
      ),
    },
    { header: "更新时间", className: "w-[180px]", cell: (row) => formatDate(row.updatedAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无模型配置"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function TaskProfilesTable(props: {
  data?: ModelTaskProfile[];
  error?: unknown;
  loading: boolean;
}) {
  const columns: Column<ModelTaskProfile>[] = [
    { header: "任务", className: "w-[220px]", cell: (row) => row.taskType },
    { header: "模型", cell: (row) => <NameWithSub name={row.modelDisplayName} sub={`${row.providerName} · ${row.modelName}`} /> },
    { header: "参数", className: "w-[220px]", cell: (row) => `temp ${row.temperature ?? "-"} · ${row.maxTokens ?? "-"} tokens` },
    { header: "状态", className: "w-[120px]", cell: (row) => <StatusBadge value={row.isEnabled ? "enabled" : "disabled"} /> },
    { header: "更新时间", className: "w-[180px]", cell: (row) => formatDate(row.updatedAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无任务路由"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function SkillsTable(props: {
  data?: DeerflowSkill[];
  error?: unknown;
  loading: boolean;
  mutate: () => Promise<unknown>;
}) {
  const columns: Column<DeerflowSkill>[] = [
    { header: "Skill", cell: (row) => <NameWithSub name={row.name} sub={row.description} /> },
    { header: "分类", className: "w-[120px]", cell: (row) => <Badge variant="outline">{row.category}</Badge> },
    {
      header: "启用",
      className: "w-[100px]",
      cell: (row) => (
        <Switch
          checked={row.enabled}
          onCheckedChange={async (checked) => {
            try {
              await updateDeerflowSkill(row.name, checked);
              toast.success(checked ? "已启用 Skill" : "已停用 Skill");
              void props.mutate();
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        />
      ),
    },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无 DeerFlow Skill"
      error={props.error}
      getRowKey={(row) => row.name}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function KnowledgeItemsTable(props: {
  data?: KnowledgeItem[];
  error?: unknown;
  loading: boolean;
  mutate: () => Promise<unknown>;
}) {
  const columns: Column<KnowledgeItem>[] = [
    { header: "知识", cell: (row) => <NameWithSub name={row.title} sub={row.summary || row.content} /> },
    { header: "类型", className: "w-[130px]", cell: (row) => row.type },
    { header: "范围", className: "w-[120px]", cell: (row) => row.scope },
    { header: "优先级", className: "w-[120px]", cell: (row) => row.priority },
    {
      header: "启用",
      className: "w-[100px]",
      cell: (row) => (
        <Switch
          checked={row.status === "active"}
          onCheckedChange={async (checked) => {
            try {
              await setKnowledgeItemEnabled(row.id, checked);
              toast.success(checked ? "已启用知识" : "已停用知识");
              void props.mutate();
            } catch (error) {
              toast.error(errorMessage(error));
            }
          }}
        />
      ),
    },
    { header: "更新时间", className: "w-[180px]", cell: (row) => formatDate(row.updatedAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无知识条目"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function KnowledgeCandidatesTable(props: {
  data?: KnowledgeCandidate[];
  error?: unknown;
  loading: boolean;
  mutate: () => Promise<unknown>;
}) {
  const columns: Column<KnowledgeCandidate>[] = [
    { header: "候选", cell: (row) => <NameWithSub name={row.title} sub={row.summary || row.reason || row.content} /> },
    { header: "类型", className: "w-[130px]", cell: (row) => row.suggestedType },
    { header: "来源", className: "w-[150px]", cell: (row) => row.source },
    { header: "状态", className: "w-[120px]", cell: (row) => <StatusBadge value={row.status} /> },
    {
      header: "操作",
      className: "w-[190px]",
      cell: (row) =>
        row.status === "pending" ? (
          <CandidateActions candidate={row} onChanged={props.mutate} />
        ) : (
          <MutedText>已处理</MutedText>
        ),
    },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无候选知识"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function RuntimeRunsTable(props: {
  data?: RuntimeRunLog[];
  error?: unknown;
  loading: boolean;
}) {
  const columns: Column<RuntimeRunLog>[] = [
    { header: "运行", cell: (row) => <NameWithSub name={row.projectTitle} sub={row.intent || row.conversationTitle} /> },
    { header: "状态", className: "w-[120px]", cell: (row) => <StatusBadge value={row.status} /> },
    { header: "步骤", className: "w-[180px]", cell: (row) => row.currentStep || "-" },
    { header: "耗时", className: "w-[100px]", cell: (row) => formatDuration(row.durationMs) },
    { header: "错误", cell: (row) => row.errorMessage ? <ErrorText error={row.errorMessage} /> : <MutedText>无</MutedText> },
    { header: "开始时间", className: "w-[180px]", cell: (row) => formatDate(row.startedAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无运行日志"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function ModelCallsTable(props: {
  data?: ModelCallLog[];
  error?: unknown;
  loading: boolean;
}) {
  const columns: Column<ModelCallLog>[] = [
    { header: "模型", cell: (row) => <NameWithSub name={row.modelDisplayName || row.modelName} sub={`${row.taskType}${row.runtimeName ? ` · ${row.runtimeName}` : ""}`} /> },
    { header: "状态", className: "w-[120px]", cell: (row) => <StatusBadge value={row.status} /> },
    { header: "Token", className: "w-[100px]", cell: (row) => row.totalTokens ?? "-" },
    { header: "耗时", className: "w-[100px]", cell: (row) => formatDuration(row.durationMs) },
    { header: "错误", cell: (row) => row.errorMessage ? <ErrorText error={row.errorMessage} /> : <MutedText>无</MutedText> },
    { header: "时间", className: "w-[180px]", cell: (row) => formatDate(row.createdAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无模型调用"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function FileParsesTable(props: {
  data?: FileParseLog[];
  error?: unknown;
  loading: boolean;
}) {
  const columns: Column<FileParseLog>[] = [
    { header: "文件", cell: (row) => <NameWithSub name={row.originalName} sub={row.projectTitle} /> },
    { header: "状态", className: "w-[140px]", cell: (row) => <StatusBadge value={row.status} /> },
    { header: "解析器", className: "w-[120px]", cell: (row) => row.parserType || "-" },
    { header: "大小", className: "w-[100px]", cell: (row) => formatBytes(row.size) },
    { header: "分块", className: "w-[80px]", cell: (row) => row.chunkCount },
    { header: "错误", cell: (row) => row.parseError ? <ErrorText error={row.parseError} /> : <MutedText>无</MutedText> },
    { header: "时间", className: "w-[180px]", cell: (row) => formatDate(row.createdAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无文件解析记录"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function QaReportsTable(props: {
  data?: QaReportLog[];
  error?: unknown;
  loading: boolean;
}) {
  const columns: Column<QaReportLog>[] = [
    { header: "项目", cell: (row) => <NameWithSub name={row.projectTitle} sub={row.summary || row.runId} /> },
    { header: "状态", className: "w-[120px]", cell: (row) => <StatusBadge value={row.status} /> },
    { header: "触发", className: "w-[120px]", cell: (row) => row.trigger },
    { header: "问题", className: "w-[120px]", cell: (row) => `${row.criticalIssueCount}/${row.issueCount}` },
    { header: "时间", className: "w-[180px]", cell: (row) => formatDate(row.createdAt) },
  ];
  return (
    <AdminTable
      columns={columns}
      emptyText="暂无 QA 报告"
      error={props.error}
      getRowKey={(row) => row.id}
      loading={props.loading}
      rows={props.data}
    />
  );
}

function CreateUserDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    email: "",
    password: "",
    role: "user" as "admin" | "user",
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await createAdminUser({
        ...form,
        email: form.email || undefined,
      });
      toast.success("用户已创建");
      props.onCreated();
      props.onOpenChange(false);
      setForm({ username: "", displayName: "", email: "", password: "", role: "user" });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
          <DialogDescription>
            创建后可在用户列表中调整角色和状态。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="用户名">
            <Input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </Field>
          <Field label="显示名称">
            <Input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
          </Field>
          <Field label="邮箱">
            <Input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="密码">
            <Input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </Field>
          <Field label="角色">
            <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value as "admin" | "user" })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">普通用户</SelectItem>
                <SelectItem value="admin">管理员</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={submitting} onClick={submit}>
            {submitting ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserRoleSelect(props: {
  user: AdminUser;
  onChanged: () => Promise<unknown>;
}) {
  return (
    <Select
      value={props.user.role}
      onValueChange={async (role) => {
        try {
          await updateAdminUser(props.user.id, { role });
          toast.success("角色已更新");
          void props.onChanged();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    >
      <SelectTrigger size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="user">普通用户</SelectItem>
        <SelectItem value="admin">管理员</SelectItem>
      </SelectContent>
    </Select>
  );
}

function UserStatusSwitch(props: {
  user: AdminUser;
  onChanged: () => Promise<unknown>;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={props.user.status === "active"}
        onCheckedChange={async (checked) => {
          try {
            await setAdminUserEnabled(props.user.id, checked);
            toast.success(checked ? "用户已启用" : "用户已停用");
            void props.onChanged();
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
      <StatusBadge value={props.user.status} />
    </div>
  );
}

function ResetPasswordButton({ user }: { user: AdminUser }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await resetAdminUserPassword(user.id, password);
      toast.success("密码已重置");
      setOpen(false);
      setPassword("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="outline">
        <KeyRoundIcon className="size-4" />
        重置
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为 {user.displayName || user.username} 设置一个新密码。
            </DialogDescription>
          </DialogHeader>
          <Field label="新密码">
            <Input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={submitting || !password} onClick={submit}>
              {submitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CandidateActions(props: {
  candidate: KnowledgeCandidate;
  onChanged: () => Promise<unknown>;
}) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [comment, setComment] = useState("");

  const approve = async () => {
    try {
      await approveKnowledgeCandidate(props.candidate.id);
      toast.success("候选知识已通过");
      void props.onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const reject = async () => {
    try {
      await rejectKnowledgeCandidate(props.candidate.id, comment);
      toast.success("候选知识已拒绝");
      setRejectOpen(false);
      setComment("");
      void props.onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button onClick={approve} size="sm" variant="outline">
        <CheckIcon className="size-4" />
        通过
      </Button>
      <Button onClick={() => setRejectOpen(true)} size="sm" variant="destructive">
        <XIcon className="size-4" />
        拒绝
      </Button>
      <Dialog onOpenChange={setRejectOpen} open={rejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>拒绝候选知识</DialogTitle>
            <DialogDescription>{props.candidate.title}</DialogDescription>
          </DialogHeader>
          <Field label="拒绝原因">
            <Input value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              取消
            </Button>
            <Button disabled={!comment} onClick={reject} variant="destructive">
              拒绝
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdminTable<T>(props: {
  rows?: T[];
  columns: Column<T>[];
  getRowKey: (row: T) => string;
  loading: boolean;
  error?: unknown;
  emptyText: string;
}) {
  if (props.error) return <ErrorText error={props.error} />;

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            {props.columns.map((column) => (
              <TableHead className={column.className} key={column.header}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.loading &&
            Array.from({ length: 4 }).map((_, index) => (
              <TableRow key={`loading-${index}`}>
                <TableCell colSpan={props.columns.length}>
                  <div className="bg-muted h-5 animate-pulse rounded" />
                </TableCell>
              </TableRow>
            ))}
          {!props.loading &&
            props.rows?.map((row) => (
              <TableRow key={props.getRowKey(row)}>
                {props.columns.map((column) => (
                  <TableCell className={column.className} key={column.header}>
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          {!props.loading && !props.rows?.length && (
            <TableRow>
              <TableCell
                className="text-muted-foreground h-24 text-center"
                colSpan={props.columns.length}
              >
                {props.emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function SectionPanel(props: {
  title: string;
  description: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">{props.title}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{props.description}</p>
        </div>
        {props.actions}
      </div>
      <Separator />
      {props.children}
    </section>
  );
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{children}</div>;
}

function MetricTile(props: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: number;
  detail?: string;
  loading?: boolean;
  tone?: "default" | "warning";
}) {
  const Icon = props.icon;
  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">{props.label}</span>
        <Icon className="text-muted-foreground size-4" />
      </div>
      <div className={cn("mt-3 text-2xl font-semibold", props.tone === "warning" && "text-amber-600")}>
        {props.loading ? "..." : formatNumber(props.value)}
      </div>
      {props.detail && <div className="text-muted-foreground mt-1 text-xs">{props.detail}</div>}
    </div>
  );
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function SearchInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-[240px]">
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input
        className="pl-9"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}

function NameWithSub({ name, sub }: { name: string; sub?: string }) {
  return (
    <div>
      <div className="max-w-[420px] truncate font-medium">{name}</div>
      {sub && <div className="text-muted-foreground line-clamp-2 max-w-[560px] text-xs">{sub}</div>}
    </div>
  );
}

function StatusPill(props: {
  label: string;
  value: string;
  variant?: React.ComponentProps<typeof Badge>["variant"];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">{props.label}</span>
      <Badge variant={props.variant ?? "outline"}>{props.value}</Badge>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const destructive =
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("disabled") ||
    normalized.includes("rejected");
  const success =
    normalized.includes("active") ||
    normalized.includes("success") ||
    normalized.includes("completed") ||
    normalized.includes("enabled") ||
    normalized.includes("approved");
  return (
    <Badge variant={destructive ? "destructive" : success ? "default" : "outline"}>
      {statusLabel(value)}
    </Badge>
  );
}

function PaginationSummary<T>({ data }: { data?: PageResponse<T> }) {
  if (!data) return null;
  return (
    <div className="text-muted-foreground text-sm">
      显示 {data.items.length} 条，共 {data.total} 条
    </div>
  );
}

function AdminScreenState(props: { title: string; description?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm text-center">
        <div className="bg-muted mx-auto mb-4 flex size-12 items-center justify-center rounded-lg">
          <ShieldCheckIcon className="text-muted-foreground size-5" />
        </div>
        <h1 className="text-lg font-semibold">{props.title}</h1>
        {props.description && (
          <p className="text-muted-foreground mt-2 text-sm">{props.description}</p>
        )}
      </div>
    </main>
  );
}

function MutedText({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground text-sm">{children}</span>;
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <span className="text-destructive line-clamp-2 text-sm">
      {errorMessage(error)}
    </span>
  );
}

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value?: number) {
  return typeof value === "number" ? value.toLocaleString("zh-CN") : "-";
}

function formatDuration(value?: number) {
  if (typeof value !== "number") return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatBytes(value?: number) {
  if (typeof value !== "number") return "-";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function shortId(value: string) {
  return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function formatUnknown(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function modelAbilityText(row: ModelConfig) {
  const abilities = [
    row.supportsStreaming ? "流式" : undefined,
    row.supportsJsonMode ? "JSON" : undefined,
    row.supportsMultimodal ? "多模态" : undefined,
  ].filter(Boolean);
  return abilities.length ? abilities.join(" · ") : "基础";
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    active: "启用",
    disabled: "停用",
    enabled: "启用",
    completed: "完成",
    success: "成功",
    failed: "失败",
    pending: "待处理",
    approved: "已通过",
    rejected: "已拒绝",
    merged: "已合并",
    running: "运行中",
    draft: "草稿",
  };
  return labels[value] ?? value;
}

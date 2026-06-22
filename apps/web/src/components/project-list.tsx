"use client";

export type Phase1Project = {
  id: string;
  title: string;
  status: string;
  currentConversationId?: string | null;
  defaultConversationId?: string | null;
};

export function ProjectList({
  projects,
  selectedProjectId,
  loading,
  onSelectProject,
}: {
  projects: Phase1Project[];
  selectedProjectId?: string;
  loading?: boolean;
  onSelectProject: (project: Phase1Project) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <div className="text-sm font-semibold text-gray-950">项目</div>
        <div className="mt-1 text-xs leading-5 text-gray-500">系统根据输入自动创建与更新项目</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="px-3 py-4 text-sm text-gray-500">加载项目中...</div>
        ) : projects.length ? (
          projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelectProject(project)}
              className={[
                "mb-1 w-full rounded-lg px-3 py-2 text-left transition",
                selectedProjectId === project.id
                  ? "bg-gray-950 text-white"
                  : "text-gray-700 hover:bg-gray-100",
              ].join(" ")}
            >
              <div className="truncate text-sm font-medium">{projectTitleLabel(project.title)}</div>
              <div className={selectedProjectId === project.id ? "mt-1 text-xs text-gray-300" : "mt-1 text-xs text-gray-400"}>
                {projectStatusLabel(project.status)}
              </div>
            </button>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-gray-200 px-3 py-8 text-center text-sm text-gray-500">
            暂无项目。直接在中间输入需求，系统会自动创建工作空间。
          </div>
        )}
      </div>
    </aside>
  );
}

function projectTitleLabel(title: string) {
  return title.replace(/Triple System/g, "三系统融合").replace(/AI Product Workbench/g, "智能产品工作台");
}

function projectStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    clarifying: "澄清中",
    designing: "设计中",
    generating: "生成中",
    waiting: "等待中",
    prd_ready: "需求文档已就绪",
    prototype_ready: "原型已就绪",
    qa_failed: "质检未通过",
    done: "已完成",
    completed: "已完成",
    archived: "已归档",
    deleted: "已删除",
  };
  return labels[status] ?? status;
}

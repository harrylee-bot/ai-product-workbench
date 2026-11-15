"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { useWorkbenchIdentity } from "@/lib/workbench/features/identity";
import { useInfiniteWorkbenchProjects } from "@/lib/workbench/features/projects";
import { useWorkbenchProjectsApi } from "@/lib/studio/api";
import { useStudioAction } from "./actions";
import { ProjectCardPresentation } from "./onlook/project-card";
export function StudioHome() {
  const router = useRouter(),
    auth = useWorkbenchAuth(),
    identity = useWorkbenchIdentity(),
    api = useWorkbenchProjectsApi(),
    action = useStudioAction();
  const [search, setSearch] = useState(""),
    [relationship, setRelationship] = useState<"owned" | "shared">("owned"),
    [title, setTitle] = useState("");
  const projects = useInfiniteWorkbenchProjects({
    q: search || undefined,
    relationship,
    limit: 50,
  });
  return (
    <main className="studio-home">
      <header>
        <Link className="studio-wordmark" href="/">
          W<span>工作台</span>
        </Link>
        <div>
          <span>{auth.user?.name}</span>
          <button onClick={() => void auth.logout()}>退出登录</button>
        </div>
      </header>
      <section className="studio-home-intro">
        <p>从想法到交付</p>
        <h1>构建下一个产品</h1>
        <p>整理资料，形成需求，与 AI 一起打磨真实可操作的原型。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (!identity.data?.defaultWorkspaceId)
                throw new Error("工作空间尚未加载");
              const result = await api.createProject(
                identity.data.defaultWorkspaceId,
                { title: title.trim() },
              );
              router.push(`/studio/${result.value.id}`);
            }, "项目已创建");
          }}
        >
          <input
            aria-label="新项目名称"
            placeholder="为你的新项目起个名字"
            value={title}
            maxLength={240}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <button disabled={action.busy || !identity.data}>创建项目 →</button>
        </form>
        {action.notice}
      </section>
      <section className="studio-projects">
        <div className="studio-view-heading">
          <h2>我的项目</h2>
          <div>
            <button
              aria-pressed={relationship === "owned"}
              onClick={() => setRelationship("owned")}
            >
              我创建的
            </button>
            <button
              aria-pressed={relationship === "shared"}
              onClick={() => setRelationship("shared")}
            >
              与我共享
            </button>
            <input
              aria-label="搜索项目"
              placeholder="搜索项目"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {projects.error && (
          <p role="alert">
            {projects.error.message}
            <button onClick={() => void projects.refetch()}>重试</button>
          </p>
        )}
        <div className="studio-project-grid">
          {projects.data?.pages
            .flatMap((p) => p.items)
            .map((project) => (
              <ProjectCardPresentation
                key={project.id}
                project={project}
                onEdit={() => router.push(`/studio/${project.id}`)}
                onClone={
                  project.role !== "viewer"
                    ? () =>
                        void action.run(async () => {
                          const result = await api.duplicateProject(project.id);
                          router.push(`/studio/${result.value.project.id}`);
                        }, "项目已复制")
                    : undefined
                }
              />
            ))}
        </div>
        {projects.isPending && <p role="status">加载项目…</p>}
        {projects.data?.pages[0]?.items.length === 0 && (
          <p>这里还没有项目，创建一个开始吧。</p>
        )}
        {projects.hasNextPage && (
          <button
            onClick={() => void projects.fetchNextPage()}
            disabled={projects.isFetchingNextPage}
          >
            加载更多
          </button>
        )}
      </section>
    </main>
  );
}

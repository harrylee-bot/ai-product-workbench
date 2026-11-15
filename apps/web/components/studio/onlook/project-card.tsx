// Derived from Onlook, Copyright 2024 On Off, Inc., Apache-2.0.
// Source: apps/web/client/src/app/projects/_components/select/project-card-presentation.tsx
// Commit 423e2e924366419e418ee049093872d535eea41a. Original in third_party/onlook.
// Modified: business project shape, semantic keyboard controls, light presentation, no template operation.
"use client";
export function ProjectCardPresentation({
  project,
  imageUrl,
  onEdit,
  onClone,
}: {
  project: { id: string; title: string; updatedAt: string };
  imageUrl?: string | null;
  onEdit: () => void;
  onClone?: () => void;
}) {
  const lastUpdated = new Date(project.updatedAt).toLocaleDateString("zh-CN");
  return (
    <article className="studio-project-card">
      <button
        className="studio-project-open"
        onClick={onEdit}
        aria-label={`打开 ${project.title}`}
      >
        <div className="studio-project-thumbnail">
          {imageUrl ? (
            <img src={imageUrl} alt={project.title} loading="lazy" />
          ) : (
            <div className="studio-project-placeholder">
              <span>◫</span>
              <span>{project.title.slice(0, 1)}</span>
            </div>
          )}
        </div>
        <div className="studio-project-card-caption">
          <h3>{project.title}</h3>
          <time>{lastUpdated} 更新</time>
        </div>
      </button>
      {onClone && (
        <button className="studio-project-copy" onClick={onClone}>
          复制项目
        </button>
      )}
    </article>
  );
}

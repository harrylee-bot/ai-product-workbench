"use client";

import { useState } from "react";
import type { RunArtifactTarget } from "@workbench/workbench-contracts";
import type { StudioArtifactContext } from "@/lib/studio/types";

export type ArtifactPrompt = (
  text: string,
  context: StudioArtifactContext,
) => void;

const actions = [
  { intent: "followup-design", label: "生成设计变体" },
  { intent: "interactive-prototype", label: "生成交互变体" },
] as const;

export function PrototypeVariants({
  source,
  versionTitle,
  screens,
  initialScreenId,
  onPrompt,
}: {
  source: Omit<RunArtifactTarget, "screenIds">;
  versionTitle: string;
  screens: readonly { id: string; title: string }[];
  initialScreenId?: string;
  onPrompt: ArtifactPrompt;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string[]>(() => {
    const initial =
      screens.find((screen) => screen.id === initialScreenId) ?? screens[0];
    return initial ? [initial.id] : [];
  });
  const selected = screens.filter((screen) => selection.includes(screen.id));
  const filtered = screens.filter((screen) =>
    screen.title
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <details
      className="studio-variant-actions"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>从此版本生成变体</summary>
      {open && (
        <>
          <p>{versionTitle}</p>
          {screens.length > 12 && (
            <label>
              筛选来源页面
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          )}
          <fieldset>
            <legend>来源页面（最多选 12 个）</legend>
            <div className="studio-variant-pages">
              {filtered.map((screen) => {
                const checked = selection.includes(screen.id);
                return (
                  <label key={screen.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selected.length >= 12}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setSelection((current) =>
                          next
                            ? [...current, screen.id]
                            : current.filter((id) => id !== screen.id),
                        );
                      }}
                    />
                    {screen.title}
                  </label>
                );
              })}
              {!filtered.length && <p>没有匹配的页面</p>}
            </div>
          </fieldset>
          <p aria-live="polite">已选 {selected.length} 个页面</p>
          <div className="visual-actions">
            {actions.map(({ intent, label }) => (
              <button
                key={intent}
                type="button"
                disabled={selected.length === 0}
                onClick={() =>
                  onPrompt(`基于所选页面${label}：`, {
                    title: `${versionTitle} · ${selected.map((screen) => screen.title).join("、")}`,
                    workflow: "generate",
                    generationIntent: intent,
                    artifactTargets: [
                      {
                        ...source,
                        screenIds: selected.map((screen) => screen.id),
                      },
                    ],
                    requestedArtifactKinds: ["prototype"],
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </details>
  );
}

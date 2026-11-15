// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/left-panel/design-panel/index.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.
"use client";
import type { ReactNode } from "react";

export type DesignTab = {
  value: string;
  label: string;
  icon: ReactNode;
  content?: ReactNode;
};
/** Onlook's rail + mutually exclusive panel, opened by click/keyboard to avoid hover traps. */
export function DesignPanel({
  tabs,
  selectedTab,
  onSelect,
}: {
  tabs: DesignTab[];
  selectedTab: string | null;
  onSelect: (tab: string | null) => void;
}) {
  const selected = tabs.find((tab) => tab.value === selectedTab);
  const handleClick = (tab: string) =>
    onSelect(selectedTab === tab ? null : tab);
  return (
    <div className="studio-design-panel">
      <nav className="studio-rail" aria-label="项目导航">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            aria-pressed={selectedTab === tab.value}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => handleClick(tab.value)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      {selected?.content && (
        <aside className="studio-context" aria-label={selected.label}>
          <div className="studio-panel-heading">
            <h2>{selected.label}</h2>
            <button aria-label="关闭面板" onClick={() => onSelect(null)}>
              ×
            </button>
          </div>
          {selected.content}
        </aside>
      )}
    </div>
  );
}

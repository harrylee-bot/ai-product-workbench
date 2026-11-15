// Derived from Onlook (Copyright 2024 On Off, Inc.), Apache-2.0.
// Upstream: apps/web/client/src/app/project/[id]/_components/main.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Modified: Workbench service boundary, scoped state, accessible light UI.
// See third_party/onlook for original source, license and modification ledger.
"use client";
import type { ReactNode } from "react";

/** Onlook editor composition with the conversation docked below the available canvas. */
export function Main({
  topBar,
  leftPanel,
  rightPanel,
  editorBar,
  canvas,
  bottomBar,
}: {
  topBar: ReactNode;
  leftPanel: ReactNode;
  rightPanel?: ReactNode;
  editorBar?: ReactNode;
  canvas: ReactNode;
  bottomBar: ReactNode;
}) {
  return (
    <div className="studio-shell" data-editor-foundation="onlook">
      <header className="studio-topbar">{topBar}</header>
      <div className="studio-body">
        <div className="studio-left-panel">{leftPanel}</div>
        <main className="studio-center">
          {editorBar && <div className="studio-editorbar">{editorBar}</div>}
          <div className="studio-canvas-slot">{canvas}</div>
          <div className="studio-bottom-bar">{bottomBar}</div>
        </main>
        {rightPanel && (
          <aside className="studio-right-panel">{rightPanel}</aside>
        )}
      </div>
    </div>
  );
}

"use client";

import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

const workbenchMergeTheme = EditorView.theme({
  "&": {
    backgroundColor: "#111214",
    color: "#e8eaed",
    height: "100%",
  },
  ".cm-content": {
    caretColor: "transparent",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "19px",
  },
  ".cm-gutters": {
    backgroundColor: "#17181b",
    borderRight: "1px solid rgba(255,255,255,0.07)",
    color: "#777c84",
  },
  ".cm-scroller": { overflow: "auto" },
}, { dark: true });

const readOnlyExtensions = [
  basicSetup,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  workbenchMergeTheme,
];

export function WorkbenchArtifactVersionMerge({
  after,
  before,
}: {
  after: string;
  before: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new MergeView({
      a: { doc: before, extensions: readOnlyExtensions },
      b: { doc: after, extensions: readOnlyExtensions },
      collapseUnchanged: { margin: 3, minSize: 6 },
      diffConfig: { scanLimit: 5_000, timeout: 1_000 },
      gutter: true,
      highlightChanges: true,
      parent,
    });
    return () => view.destroy();
  }, [after, before]);

  return (
    <div
      aria-label="版本内容比较"
      className="h-full min-h-[300px] overflow-hidden bg-[#111214] [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-hidden [&_.cm-mergeViewEditors]:h-full [&_.cm-mergeViewEditor]:min-w-0"
      data-artifact-version-merge
      ref={hostRef}
      role="region"
    />
  );
}

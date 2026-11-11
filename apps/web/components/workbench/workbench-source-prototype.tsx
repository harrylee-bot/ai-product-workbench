"use client";

import type { PublicSourcePrototypeDocument, SourcePrototypeDocument, SourcePrototypeInput } from "@workbench/workbench-contracts";
import { useState } from "react";

import { useWorkbenchSourcePrototypePreviewCreator } from "../../lib/workbench/features/artifacts";
import { publicShareTokenScope, useWorkbenchPublicSourcePrototypePreviewCreator } from "../../lib/workbench/features/public-shares";
import type { WorkbenchArtifactReference } from "./workbench-artifact-reference";
import { WorkbenchIsolatedPreview } from "./workbench-isolated-preview";
import { WorkbenchSourcePrototypeDialog } from "./workbench-source-prototype-dialog";

export function WorkbenchSourcePrototype({ document, editable = false, editingBusy = false, onCommit, reference }: {
  document: SourcePrototypeDocument | PublicSourcePrototypeDocument;
  editable?: boolean;
  editingBusy?: boolean;
  onCommit?: (reference: WorkbenchArtifactReference, document: SourcePrototypeInput) => Promise<void>;
  reference: WorkbenchArtifactReference;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const privatePreview = useWorkbenchSourcePrototypePreviewCreator(reference.artifactId, reference.artifactVersionId);
  const publicPreview = useWorkbenchPublicSourcePrototypePreviewCreator(reference.shareToken ?? "", reference.artifactId, reference.artifactVersionId);
  const privateDocument = "files" in document ? document : null;
  const canEdit = editable && !reference.shareToken && privateDocument !== null && Boolean(onCommit);
  return <div className="nowheel flex h-full min-h-[320px] w-full flex-col overflow-hidden" data-workbench-source-prototype>
    {canEdit && <div className="flex shrink-0 justify-end border-b border-white/10 bg-[#18191b] px-3 py-2">
      <button className="rounded-full border border-white/15 px-3 py-1 text-xs text-[#dce0e7] hover:bg-white/5 disabled:opacity-50" disabled={editingBusy} onClick={() => setEditorOpen(true)} type="button">编辑源码</button>
    </div>}
    <div className="min-h-0 flex-1">
      <WorkbenchIsolatedPreview createPreview={reference.shareToken ? publicPreview : privatePreview}
        refreshKey={0} selection={{ kind: "artifact", artifactId: reference.artifactId, artifactVersionId: reference.artifactVersionId }}
        sessionKey={`source:${reference.shareToken ? `public:${publicShareTokenScope(reference.shareToken)}` : reference.projectId}:${reference.artifactId}:${reference.artifactVersionId}`}
        title={document.title} />
    </div>
    {editorOpen && privateDocument && onCommit && <WorkbenchSourcePrototypeDialog document={privateDocument}
      onCommit={(next) => onCommit(reference, next)} onOpenChange={setEditorOpen} open projectId={reference.projectId} />}
  </div>;
}

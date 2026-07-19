import type { ProjectRole } from "@workbench/workbench-contracts";

export type WorkbenchProjectCapabilities = {
  canArchive: boolean;
  canDuplicate: boolean;
  canEdit: boolean;
  canExport: boolean;
  canPreview: boolean;
  canManageMembers: boolean;
  canRun: boolean;
  canShare: boolean;
  canUpload: boolean;
};

const noProjectCapabilities: WorkbenchProjectCapabilities = {
  canArchive: false,
  canDuplicate: false,
  canEdit: false,
  canExport: false,
  canPreview: false,
  canManageMembers: false,
  canRun: false,
  canShare: false,
  canUpload: false,
};

export function workbenchProjectCapabilities(
  role: ProjectRole | null | undefined,
): WorkbenchProjectCapabilities {
  if (!role) return noProjectCapabilities;
  if (role === "viewer") return { ...noProjectCapabilities, canDuplicate: true, canPreview: true };

  const editorCapabilities: WorkbenchProjectCapabilities = {
    ...noProjectCapabilities,
    canDuplicate: true,
    canEdit: true,
    canExport: true,
    canPreview: true,
    canRun: true,
    canUpload: true,
  };
  if (role === "editor") return editorCapabilities;
  return {
    ...editorCapabilities,
    canArchive: true,
    canManageMembers: true,
    canShare: true,
  };
}

"use client";

import { useCallback } from "react";
import { toast } from "sonner";

import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "../project-session";

export type WorkbenchProjectActionOperations = {
  onArchiveProject: () => Promise<unknown>;
  onDuplicateProject: () => Promise<unknown>;
  onRenameProject: (title: string) => Promise<unknown>;
};

export type WorkbenchProjectActionsControllerOptions = WorkbenchProjectActionOperations & {
  canArchive: boolean;
  canDuplicate: boolean;
  canRename: boolean;
  onArchived: () => void;
  projectId: string;
};

export function useWorkbenchProjectActionsController({
  canArchive,
  canDuplicate,
  canRename,
  onArchiveProject,
  onArchived,
  onDuplicateProject,
  onRenameProject,
  projectId,
}: WorkbenchProjectActionsControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const [archiveConfirmationOpen, setArchiveConfirmationOpen] = useWorkbenchProjectState(
    session,
    () => false,
  );
  const [archiveFailed, setArchiveFailed] = useWorkbenchProjectState(session, () => false);
  const [projectActionBusy, setProjectActionBusy] = useWorkbenchProjectState(session, () => false);
  const [renameOpen, setRenameOpen] = useWorkbenchProjectState(session, () => false);
  const projectActionBusyRef = useWorkbenchProjectRef(session, () => false);

  const requestArchiveProject = useCallback(() => {
    setArchiveFailed(false);
    setArchiveConfirmationOpen(true);
  }, [setArchiveConfirmationOpen, setArchiveFailed]);

  const confirmArchiveProject = useCallback(() => {
    if (!canArchive || projectActionBusyRef.current) return false;
    projectActionBusyRef.current = true;
    setProjectActionBusy(true);
    setArchiveFailed(false);
    void onArchiveProject()
      .then(() => {
        if (!session.isCurrent()) return;
        setArchiveConfirmationOpen(false);
        onArchived();
      })
      .catch(() => {
        if (session.isCurrent()) setArchiveFailed(true);
      })
      .finally(() => {
        if (!session.isCurrent()) return;
        projectActionBusyRef.current = false;
        setProjectActionBusy(false);
      });
    return true;
  }, [
    canArchive,
    onArchiveProject,
    onArchived,
    projectActionBusyRef,
    session,
    setArchiveConfirmationOpen,
    setArchiveFailed,
    setProjectActionBusy,
  ]);

  const duplicateProject = useCallback(() => {
    if (!canDuplicate || projectActionBusyRef.current) return false;
    projectActionBusyRef.current = true;
    setProjectActionBusy(true);
    void onDuplicateProject()
      .catch(() => {
        if (session.isCurrent()) toast.error("复制项目失败，请重试");
      })
      .finally(() => {
        if (!session.isCurrent()) return;
        projectActionBusyRef.current = false;
        setProjectActionBusy(false);
      });
    return true;
  }, [
    canDuplicate,
    onDuplicateProject,
    projectActionBusyRef,
    session,
    setProjectActionBusy,
  ]);

  const requestRenameProject = useCallback(() => {
    if (!canRename) return false;
    setRenameOpen(true);
    return true;
  }, [canRename, setRenameOpen]);

  const closeRenameProject = useCallback(() => setRenameOpen(false), [setRenameOpen]);

  return {
    archiveConfirmationOpen,
    archiveFailed,
    closeRenameProject,
    confirmArchiveProject,
    duplicateProject,
    projectActionBusy,
    renameOpen,
    renameProject: onRenameProject,
    requestArchiveProject,
    requestRenameProject,
    setArchiveConfirmationOpen,
  };
}

export type WorkbenchProjectActionsController = ReturnType<
  typeof useWorkbenchProjectActionsController
>;

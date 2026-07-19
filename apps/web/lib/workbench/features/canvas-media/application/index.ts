"use client";

import type { CreateBoardArtifactInput } from "../../board";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  useWorkbenchCanvasMediaInfrastructure,
  type WorkbenchCanvasMediaUpload,
} from "../api-adapter";
import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "../../../project-session";
import {
  workbenchCanvasMediaArtifactTitle,
  workbenchCanvasMediaBoardSize,
  workbenchCanvasMediaUploadProgress,
} from "../domain";

export type WorkbenchCanvasMediaPoint = {
  x: number;
  y: number;
};

export type WorkbenchCanvasMediaStageRect = WorkbenchCanvasMediaPoint & {
  height: number;
  width: number;
};

export type WorkbenchCanvasMediaArtifactReference = {
  artifactId: string;
  artifactVersionId: string;
  projectId: string;
};

export type WorkbenchCanvasMediaSelection = {
  artifact: WorkbenchCanvasMediaArtifactReference | null;
  hasSelection: boolean;
  nodeIds: string[];
};

export type WorkbenchCanvasMediaPort = {
  addBoardArtifact: (input: CreateBoardArtifactInput) => string;
  getStageRect: () => WorkbenchCanvasMediaStageRect | null;
  screenToFlowPosition: (point: WorkbenchCanvasMediaPoint) => WorkbenchCanvasMediaPoint;
  selectNode: (nodeId: string) => void;
  selectTool: (tool: "select") => void;
  updateExportSelection: (selection: WorkbenchCanvasMediaSelection) => void;
  writeSelectedNodeUrl: (nodeIds: readonly string[]) => void;
};

export type WorkbenchCanvasMediaControllerOptions = {
  canEdit: boolean;
  exportOpen: boolean;
  port: WorkbenchCanvasMediaPort;
  projectId: string;
};

export function useWorkbenchCanvasMediaController({
  canEdit,
  exportOpen,
  port,
  projectId,
}: WorkbenchCanvasMediaControllerOptions) {
  const session = useWorkbenchProjectSession(projectId);
  const infrastructure = useWorkbenchCanvasMediaInfrastructure(projectId);
  const [uploading, setUploading] = useWorkbenchProjectState(session, () => false);
  const [progress, setProgress] = useWorkbenchProjectState<number | null>(session, () => null);
  const [error, setError] = useWorkbenchProjectState<string | null>(session, () => null);
  const mountedRef = useRef(true);
  const busyRef = useWorkbenchProjectRef(session, () => false);
  const activeOperationRef = useWorkbenchProjectRef<symbol | null>(session, () => null);
  const activeUploadCleanupRef = useWorkbenchProjectRef<(() => void) | null>(session, () => null);
  const fileByOperationRef = useWorkbenchProjectRef(session, () => new Map<string, string>());
  const optionsRef = useWorkbenchProjectRef(session, () => ({ canEdit, exportOpen, port, projectId }));
  const infrastructureRef = useWorkbenchProjectRef(session, () => infrastructure);
  optionsRef.current = { canEdit, exportOpen, port, projectId };
  infrastructureRef.current = infrastructure;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      activeOperationRef.current = null;
      busyRef.current = false;
      const cleanupUpload = activeUploadCleanupRef.current;
      activeUploadCleanupRef.current = null;
      cleanupUpload?.();
      fileByOperationRef.current.clear();
    };
  }, [activeOperationRef, activeUploadCleanupRef, busyRef, fileByOperationRef]);

  const insertMedia = useCallback(async (file: File, operationId: string) => {
    const options = optionsRef.current;
    const operationInfrastructure = infrastructureRef.current;
    if (
      !options.canEdit
      || busyRef.current
      || operationInfrastructure.artifact.isPending
    ) return;

    const operation = Symbol(operationId);
    const isActive = () => (
      mountedRef.current
      && session.isCurrent()
      && activeOperationRef.current === operation
      && optionsRef.current.projectId === options.projectId
    );
    busyRef.current = true;
    activeOperationRef.current = operation;
    setUploading(true);
    setProgress(0);
    setError(null);
    let upload: WorkbenchCanvasMediaUpload | null = null;
    let unsubscribe: (() => void) | null = null;
    let uploadDisposed = false;
    const cleanupUpload = () => {
      if (uploadDisposed) return;
      uploadDisposed = true;
      unsubscribe?.();
      upload?.destroy();
    };

    try {
      const size = await workbenchCanvasMediaBoardSize(file);
      if (!isActive()) return;
      const stage = options.port.getStageRect();
      if (!stage) throw new Error("项目画布尚未就绪");
      const center = options.port.screenToFlowPosition({
        x: stage.x + (stage.width / 2),
        y: stage.y + (stage.height / 2),
      });
      let fileAssetId = fileByOperationRef.current.get(operationId) ?? null;
      if (!fileAssetId) {
        upload = await operationInfrastructure.createUpload(file);
        if (!isActive()) return;
        activeUploadCleanupRef.current = cleanupUpload;
        unsubscribe = upload.subscribe((snapshot) => {
          if (isActive()) setProgress(workbenchCanvasMediaUploadProgress(snapshot));
        });
        const result = await upload.start();
        if (!isActive()) return;
        if (result.phase !== "ready" || !result.fileAssetId) {
          throw new Error(`图片 ${file.name} 未完成上传`);
        }
        fileAssetId = result.fileAssetId;
        fileByOperationRef.current.set(operationId, fileAssetId);
      }

      setProgress(97);
      const creation = await operationInfrastructure.artifact.create({
        idempotencyKey: `artifact:${operationId}`,
        request: {
          kind: "image",
          title: workbenchCanvasMediaArtifactTitle(file.name),
          source: { kind: "file", fileAssetId },
        },
      });
      if (!isActive()) return;
      const nodeId = options.port.addBoardArtifact({
        artifactId: creation.artifact.id,
        artifactVersionId: creation.artifactVersion.artifactVersionId,
        artifactKind: "image",
        title: creation.artifact.title,
        x: center.x - (size.width / 2),
        y: center.y - (size.height / 2),
        width: size.width,
        height: size.height,
      });
      if (!nodeId) throw new Error("图片产物已创建，但项目画布已经关闭");
      options.port.selectNode(nodeId);
      options.port.writeSelectedNodeUrl([nodeId]);
      if (options.exportOpen) {
        options.port.updateExportSelection({
          artifact: {
            artifactId: creation.artifact.id,
            artifactVersionId: creation.artifactVersion.artifactVersionId,
            projectId: options.projectId,
          },
          hasSelection: true,
          nodeIds: [nodeId],
        });
      }
      setProgress(100);
      toast.success("图片已插入");
      options.port.selectTool("select");
    } catch (cause) {
      if (isActive()) setError(mediaErrorMessage(cause));
    } finally {
      cleanupUpload();
      if (activeUploadCleanupRef.current === cleanupUpload) {
        activeUploadCleanupRef.current = null;
      }
      if (isActive()) {
        activeOperationRef.current = null;
        busyRef.current = false;
        setUploading(false);
      }
    }
  }, [
    activeOperationRef,
    activeUploadCleanupRef,
    busyRef,
    fileByOperationRef,
    infrastructureRef,
    optionsRef,
    session,
    setError,
    setProgress,
    setUploading,
  ]);

  const close = useCallback(() => {
    if (!mountedRef.current || !session.isCurrent()) return;
    setError(null);
    setProgress(null);
    optionsRef.current.port.selectTool("select");
  }, [optionsRef, session, setError, setProgress]);

  return {
    busy: uploading || infrastructure.artifact.isPending,
    close,
    error,
    insertMedia,
    progress,
  };
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "图片插入失败，请重试";
}

"use client";

import type {
  ArtifactCreation,
  CreateArtifactRequest,
} from "@workbench/workbench-contracts";
import { useCallback } from "react";

import { useCreateWorkbenchArtifact } from "../../artifacts";
import {
  createWorkbenchMultipartUpload,
  useWorkbenchFileTransferService,
  type WorkbenchMultipartUpload,
} from "../../files";

type CreateImageArtifactRequest = Extract<CreateArtifactRequest, { kind: "image" }>;

export type WorkbenchCanvasMediaArtifactPort = {
  create: (input: {
    idempotencyKey: string;
    request: CreateImageArtifactRequest;
  }) => Promise<ArtifactCreation>;
  isPending: boolean;
};

export type WorkbenchCanvasMediaUpload = Pick<
  WorkbenchMultipartUpload,
  "destroy" | "start" | "subscribe"
>;

export type WorkbenchCanvasMediaInfrastructure = {
  artifact: WorkbenchCanvasMediaArtifactPort;
  createUpload: (file: File) => Promise<WorkbenchCanvasMediaUpload>;
};

export function useWorkbenchCanvasMediaInfrastructure(
  projectId: string,
): WorkbenchCanvasMediaInfrastructure {
  const artifactMutation = useCreateWorkbenchArtifact(projectId);
  const fileTransferService = useWorkbenchFileTransferService();
  const createUpload = useCallback((file: File) => createWorkbenchMultipartUpload({
    projectId,
    file,
    service: fileTransferService,
    requestExtraction: false,
  }), [fileTransferService, projectId]);

  return {
    artifact: {
      create: artifactMutation.mutateAsync,
      isPending: artifactMutation.isPending,
    },
    createUpload,
  };
}

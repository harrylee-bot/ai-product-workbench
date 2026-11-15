"use client";

import {
  createPrototypeExportRequestSchema,
  createPrototypeFeedbackRequestSchema,
  createPrototypePlanRequestSchema,
  createPrototypeShareRequestSchema,
  prototypeExportSchema,
  exportPreviewTokenResponseSchema,
  prototypeFeedbackSchema,
  prototypePlanSchema,
  prototypePlanListSchema,
  prototypeFeedbackListSchema,
  prototypeShareListSchema,
  prototypeExportListSchema,
  revisePrototypeRevisionRequestSchema,
  prototypeRevisionSchema,
  prototypeRevisionDiffSchema,
  prototypeRevisionListSchema,
  prototypeShareSchema,
  prototypeWorkflowActionRequestSchema,
  type CreatePrototypeExportRequest,
  type CreatePrototypeFeedbackRequest,
  type CreatePrototypePlanRequest,
  type CreatePrototypeShareRequest,
  type PrototypeExport,
  type ExportPreviewTokenResponse,
  type PrototypeFeedback,
  type PrototypePlan,
  type PrototypeRevision,
  type PrototypeRevisionList,
  type PrototypeShare,
  type PrototypeWorkflowActionRequest,
  type RevisePrototypeRevisionRequest,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { isWorkbenchBlob } from "../../../transport/blob";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  requireData,
  versioned,
  WorkbenchContractError,
  type Versioned,
} from "../../../transport/contracts";

export class WorkbenchPrototypeV2Api {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listPlans(projectId: string) {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/plans", { params: { path: { projectId } } });
    return parseContract(prototypePlanListSchema, result.data, "list prototype plans");
  }

  async getRevision(projectId: string, revisionId: string): Promise<Versioned<PrototypeRevision>> {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/revisions/{revisionId}", { params: { path: { projectId, revisionId } } });
    return versioned(prototypeRevisionSchema, result.data, result.response, "get prototype revision");
  }

  async getRevisionDiff(projectId: string, revisionId: string) {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/revisions/{revisionId}/diff", { params: { path: { projectId, revisionId } } });
    return parseContract(prototypeRevisionDiffSchema, result.data, "compare prototype revisions");
  }

  async listFeedback(projectId: string, revisionId: string) {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/revisions/{revisionId}/feedback", { params: { path: { projectId, revisionId } } });
    return parseContract(prototypeFeedbackListSchema, result.data, "list prototype feedback");
  }

  async listShares(projectId: string) {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/shares", { params: { path: { projectId } } });
    return parseContract(prototypeShareListSchema, result.data, "list prototype shares");
  }

  async listExports(projectId: string) {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/exports", { params: { path: { projectId } } });
    return parseContract(prototypeExportListSchema, result.data, "list prototype exports");
  }

  async reviseRevision(projectId: string, revisionId: string, ifMatch: string, request: RevisePrototypeRevisionRequest, idempotencyKey = createIdempotencyKey("prototype-revise")): Promise<Versioned<PrototypePlan>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/revisions/{revisionId}/revise", {
      params: { path: { projectId, revisionId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: revisePrototypeRevisionRequestSchema.parse(request),
    });
    return versioned(prototypePlanSchema, result.data, result.response, "revise prototype revision");
  }

  async createPlan(projectId: string, request: CreatePrototypePlanRequest, idempotencyKey = createIdempotencyKey("prototype-plan")): Promise<Versioned<PrototypePlan>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/plans", {
      params: { path: { projectId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) } },
      body: createPrototypePlanRequestSchema.parse(request),
    });
    return versioned(prototypePlanSchema, result.data, result.response, "create prototype plan");
  }

  async getPlan(projectId: string, planId: string): Promise<Versioned<PrototypePlan>> {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/plans/{planId}", { params: { path: { projectId, planId } } });
    return versioned(prototypePlanSchema, result.data, result.response, "get prototype plan");
  }

  async listRevisions(projectId: string, planId: string): Promise<PrototypeRevisionList> {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/plans/{planId}/revisions", { params: { path: { projectId, planId } } });
    return parseContract(prototypeRevisionListSchema, result.data, "list prototype revisions");
  }

  async createPreviewToken(projectId: string, revisionId: string): Promise<ExportPreviewTokenResponse> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/revisions/{revisionId}/preview-token", { params: { path: { projectId, revisionId } } });
    return parseContract(exportPreviewTokenResponseSchema, result.data, "create prototype preview token");
  }

  async confirmRevision(projectId: string, revisionId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-confirm")): Promise<Versioned<PrototypeRevision>> {
    return this.reviewRevision("confirm", projectId, revisionId, ifMatch, request, idempotencyKey);
  }

  async rejectRevision(projectId: string, revisionId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-reject")): Promise<Versioned<PrototypeRevision>> {
    return this.reviewRevision("reject", projectId, revisionId, ifMatch, request, idempotencyKey);
  }

  async approvePlan(projectId: string, planId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-approve")): Promise<Versioned<PrototypePlan>> {
    return this.actionPlan("approve", projectId, planId, ifMatch, request, idempotencyKey);
  }

  async retryPlan(projectId: string, planId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-plan-retry")): Promise<Versioned<PrototypePlan>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/plans/{planId}/retry", {
      params: { path: { projectId, planId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: prototypeWorkflowActionRequestSchema.parse(request),
    });
    return versioned(prototypePlanSchema, result.data, result.response, "retry prototype plan");
  }

  async cancelPlan(projectId: string, planId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-cancel")): Promise<Versioned<PrototypePlan>> {
    return this.actionPlan("cancel", projectId, planId, ifMatch, request, idempotencyKey);
  }

  async createFeedback(projectId: string, revisionId: string, request: CreatePrototypeFeedbackRequest, idempotencyKey = createIdempotencyKey("prototype-feedback")): Promise<Versioned<PrototypeFeedback>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/revisions/{revisionId}/feedback", {
      params: { path: { projectId, revisionId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) } },
      body: createPrototypeFeedbackRequestSchema.parse(request),
    });
    return versioned(prototypeFeedbackSchema, result.data, result.response, "create prototype feedback");
  }

  async resolveFeedback(projectId: string, feedbackId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-feedback-resolve")): Promise<Versioned<PrototypeFeedback>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/feedback/{feedbackId}/resolve", {
      params: { path: { projectId, feedbackId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: prototypeWorkflowActionRequestSchema.parse(request),
    });
    return versioned(prototypeFeedbackSchema, result.data, result.response, "resolve prototype feedback");
  }

  async createShare(projectId: string, request: CreatePrototypeShareRequest, idempotencyKey = createIdempotencyKey("prototype-share")): Promise<Versioned<PrototypeShare>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/shares", {
      params: { path: { projectId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) } },
      body: createPrototypeShareRequestSchema.parse(request),
    });
    return versioned(prototypeShareSchema, result.data, result.response, "create prototype share");
  }

  async revokeShare(projectId: string, shareId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-share-revoke")): Promise<Versioned<PrototypeShare>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/shares/{shareId}/revoke", {
      params: { path: { projectId, shareId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: prototypeWorkflowActionRequestSchema.parse(request),
    });
    return versioned(prototypeShareSchema, result.data, result.response, "revoke prototype share");
  }

  async createExport(projectId: string, request: CreatePrototypeExportRequest, idempotencyKey = createIdempotencyKey("prototype-export")): Promise<Versioned<PrototypeExport>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/exports", {
      params: { path: { projectId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) } },
      body: createPrototypeExportRequestSchema.parse(request),
    });
    return versioned(prototypeExportSchema, result.data, result.response, "create prototype export");
  }

  async getExport(projectId: string, exportId: string): Promise<Versioned<PrototypeExport>> {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/exports/{exportId}", { params: { path: { projectId, exportId } } });
    return versioned(prototypeExportSchema, result.data, result.response, "get prototype export");
  }

  async downloadExport(projectId: string, exportId: string): Promise<Blob> {
    const result = await this.api.GET("/projects/{projectId}/prototype-v2/exports/{exportId}/download", {
      params: { path: { projectId, exportId } },
      headers: { Accept: "application/octet-stream" },
      parseAs: "blob",
    });
    const content = requireData(result.data, "download prototype export");
    if (!isWorkbenchBlob(content)) {
      throw new WorkbenchContractError("download prototype export");
    }
    return content;
  }

  async retryExport(projectId: string, exportId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-export-retry")): Promise<Versioned<PrototypeExport>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/exports/{exportId}/retry", {
      params: { path: { projectId, exportId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: prototypeWorkflowActionRequestSchema.parse(request),
    });
    return versioned(prototypeExportSchema, result.data, result.response, "retry prototype export");
  }

  async cancelExport(projectId: string, exportId: string, ifMatch: string, request: PrototypeWorkflowActionRequest = {}, idempotencyKey = createIdempotencyKey("prototype-export-cancel")): Promise<Versioned<PrototypeExport>> {
    const result = await this.api.POST("/projects/{projectId}/prototype-v2/exports/{exportId}/cancel", {
      params: { path: { projectId, exportId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } },
      body: prototypeWorkflowActionRequestSchema.parse(request),
    });
    return versioned(prototypeExportSchema, result.data, result.response, "cancel prototype export");
  }

  private async reviewRevision(kind: "confirm" | "reject", projectId: string, revisionId: string, ifMatch: string, request: PrototypeWorkflowActionRequest, idempotencyKey: string): Promise<Versioned<PrototypeRevision>> {
    const body = prototypeWorkflowActionRequestSchema.parse(request);
    const result = kind === "confirm"
      ? await this.api.POST("/projects/{projectId}/prototype-v2/revisions/{revisionId}/confirm", { params: { path: { projectId, revisionId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } }, body })
      : await this.api.POST("/projects/{projectId}/prototype-v2/revisions/{revisionId}/reject", { params: { path: { projectId, revisionId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } }, body });
    return versioned(prototypeRevisionSchema, result.data, result.response, `${kind} prototype revision`);
  }

  private async actionPlan(kind: "approve" | "cancel", projectId: string, planId: string, ifMatch: string, request: PrototypeWorkflowActionRequest, idempotencyKey: string): Promise<Versioned<PrototypePlan>> {
    const body = prototypeWorkflowActionRequestSchema.parse(request);
    const result = kind === "approve"
      ? await this.api.POST("/projects/{projectId}/prototype-v2/plans/{planId}/approve", { params: { path: { projectId, planId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } }, body })
      : await this.api.POST("/projects/{projectId}/prototype-v2/plans/{planId}/cancel", { params: { path: { projectId, planId }, header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey), "If-Match": normalizeEtag(ifMatch) } }, body });
    return versioned(prototypePlanSchema, result.data, result.response, `${kind} prototype plan`);
  }
}

export function useWorkbenchPrototypeV2Api(): WorkbenchPrototypeV2Api {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchPrototypeV2Api(api), [api]);
}

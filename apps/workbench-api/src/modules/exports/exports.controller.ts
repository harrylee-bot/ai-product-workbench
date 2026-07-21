import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createExternalExportDeliveryRequestSchema,
  createExportJobRequestSchema,
  type CreateExternalExportDeliveryRequest,
  type CreateExportJobRequest,
  createProjectPreviewRequestSchema,
  type CreateProjectPreviewRequest,
} from "@workbench/workbench-contracts";
import {
  attachmentContentDisposition,
  entityTagMatches,
  UnsatisfiedByteRangeProblem,
} from "../../common/byte-content.js";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { httpResponseAbortSignalArgument } from "../../common/http-request-abort.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ExportsService } from "./exports.service.js";
import { ExternalExportDeliveriesService } from "./external-export-deliveries.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ExportsController {
  constructor(
    private readonly exportsService: ExportsService,
    private readonly externalDeliveries: ExternalExportDeliveriesService,
  ) {}

  @Get("projects/:projectId/exports")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.exportsService.list(principal.id, projectId, cursor || undefined, parseExportLimit(limit));
  }

  @Post("projects/:projectId/exports")
  @HttpCode(202)
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createExportJobRequestSchema)) body: CreateExportJobRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const job = await this.exportsService.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(job.revision));
    response.setHeader("Location", `/api/v1/exports/${job.id}`);
    return job;
  }

  @Get("exports/capabilities")
  capabilities() {
    return this.exportsService.capabilities();
  }

  @Get("exports/:exportId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const job = await this.exportsService.get(principal.id, exportId);
    const etag = revisionEtag(job.revision);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return job;
  }

  @Post("exports/:exportId/cancel")
  @HttpCode(200)
  async cancel(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const job = await this.exportsService.cancel(principal.id, exportId, parseIfMatch(ifMatch));
    response.setHeader("ETag", revisionEtag(job.revision));
    return job;
  }

  @Post("exports/:exportId/preview-token")
  @HttpCode(200)
  async createPreviewToken(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const capability = await this.exportsService.createPreviewToken(principal.id, exportId);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    return capability;
  }

  @Post("projects/:projectId/previews")
  @HttpCode(202)
  async createPreview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createProjectPreviewRequestSchema)) body: CreateProjectPreviewRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const preview = await this.exportsService.createPreview(principal.id, projectId, idempotencyKey, body);
    response.setHeader("Location", `/api/v1/previews/${preview.id}`);
    return preview;
  }

  @Get("previews/:previewId")
  async getPreview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("previewId") previewId: string,
  ) {
    return this.exportsService.getPreview(principal.id, previewId);
  }

  @Post("previews/:previewId/token")
  @HttpCode(200)
  async createProjectPreviewToken(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("previewId") previewId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const capability = await this.exportsService.createProjectPreviewToken(principal.id, previewId);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    return capability;
  }

  @Get("exports/:exportId/content")
  async content(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.exportsService.getContent(
        principal.id,
        exportId,
        range,
        ifNoneMatch,
        ...httpResponseAbortSignalArgument(response),
      );
    } catch (error) {
      if (error instanceof UnsatisfiedByteRangeProblem) {
        response.setHeader("Content-Range", `bytes */${error.byteSize}`);
      }
      throw error;
    }
    response.setHeader("ETag", result.etag);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-cache");
    if (result.notModified) {
      response.status(304);
      return undefined;
    }
    response.setHeader("Content-Type", result.mediaType);
    response.setHeader("Content-Length", String(result.byteSize));
    response.setHeader("Content-Disposition", attachmentContentDisposition(result.fileName));
    if (result.range) {
      response.status(206);
      response.setHeader("Content-Range", result.contentRange!);
    }
    return new StreamableFile(result.body);
  }

  @Get("exports/:exportId/deliveries")
  listExternalDeliveries(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.externalDeliveries.list(principal.id, exportId);
  }

  @Post("exports/:exportId/deliveries")
  @HttpCode(201)
  async createExternalDelivery(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("exportId") exportId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createExternalExportDeliveryRequestSchema)) body: CreateExternalExportDeliveryRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const delivery = await this.externalDeliveries.create(principal.id, exportId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(delivery.revision));
    response.setHeader("Location", `/api/v1/export-deliveries/${delivery.id}`);
    return delivery;
  }

  @Get("export-deliveries/:deliveryId")
  async getExternalDelivery(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("deliveryId") deliveryId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const delivery = await this.externalDeliveries.get(principal.id, deliveryId);
    const etag = revisionEtag(delivery.revision);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return delivery;
  }

  @Post("export-deliveries/:deliveryId/confirm")
  @HttpCode(202)
  async confirmExternalDelivery(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("deliveryId") deliveryId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const delivery = await this.externalDeliveries.confirm(principal.id, deliveryId, parseIfMatch(ifMatch));
    response.setHeader("ETag", revisionEtag(delivery.revision));
    return delivery;
  }

  @Post("export-deliveries/:deliveryId/retry")
  @HttpCode(202)
  async retryExternalDelivery(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("deliveryId") deliveryId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const delivery = await this.externalDeliveries.retry(principal.id, deliveryId, parseIfMatch(ifMatch));
    response.setHeader("ETag", revisionEtag(delivery.revision));
    return delivery;
  }

  @Post("export-deliveries/:deliveryId/cancel")
  @HttpCode(202)
  async cancelExternalDelivery(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("deliveryId") deliveryId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const delivery = await this.externalDeliveries.cancel(principal.id, deliveryId, parseIfMatch(ifMatch));
    response.setHeader("ETag", revisionEtag(delivery.revision));
    return delivery;
  }
}

export function parseExportLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

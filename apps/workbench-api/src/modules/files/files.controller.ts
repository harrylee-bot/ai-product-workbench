import {
  Body,
  Controller,
  Delete,
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
  completeFileUploadRequestSchema,
  createFileUploadRequestSchema,
  fileStatusSchema,
  signUploadPartRequestSchema,
  uploadPartNumberSchema,
  type CompleteFileUploadRequest,
  type CreateFileUploadRequest,
  type FileStatus,
  type SignUploadPartRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import {
  entityTagMatches,
  inlineContentDisposition,
  UnsatisfiedByteRangeProblem,
} from "../../common/byte-content.js";
import { validationProblem } from "../../common/problem-details.js";
import { httpResponseAbortSignalArgument } from "../../common/http-request-abort.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { FileUploadsService } from "./file-uploads.service.js";
import { FilesService } from "./files.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly uploads: FileUploadsService,
  ) {}

  @Get("projects/:projectId/files")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("status") status?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.files.list(
      principal.id,
      projectId,
      parseFileStatus(status),
      cursor || undefined,
      parseFileLimit(limit),
    );
  }

  @Post("projects/:projectId/file-upload-sessions")
  async createUpload(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createFileUploadRequestSchema)) body: CreateFileUploadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.uploads.create(principal.id, projectId, requireIdempotencyKey(idempotencyKey), body);
    response.setHeader("ETag", revisionEtag(result.upload.revision));
    response.setHeader("Location", `/api/v1/file-upload-sessions/${result.upload.id}`);
    return result;
  }

  @Get("files/:fileId")
  async getFile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("fileId") fileId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.files.get(principal.id, fileId);
    const etag = revisionEtag(file.revision);
    setPrivateRevisionHeaders(response, etag);
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return file;
  }

  @Delete("files/:fileId")
  @HttpCode(204)
  async deleteFile(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("fileId") fileId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    await this.files.delete(principal.id, fileId, parseIfMatch(ifMatch));
  }

  @Get("files/:fileId/content")
  async getFileContent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("fileId") fileId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.files.getContent(
        principal.id,
        fileId,
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
    response.setHeader("Content-Disposition", inlineContentDisposition(result.fileName));
    if (result.range) {
      response.status(206);
      response.setHeader("Content-Range", result.contentRange!);
    }
    return new StreamableFile(result.body);
  }

  @Post("files/:fileId/extractions")
  @HttpCode(202)
  async createExtraction(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("fileId") fileId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.files.createExtraction(
      principal.id,
      fileId,
      parseIfMatch(ifMatch),
      requireIdempotencyKey(idempotencyKey),
    );
    response.setHeader("ETag", revisionEtag(result.fileRevision));
    response.setHeader("Location", `/api/v1/files/${fileId}`);
    return result.extraction;
  }

  @Get("file-upload-sessions/:uploadSessionId")
  async getUpload(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("uploadSessionId") uploadSessionId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const upload = await this.uploads.get(principal.id, uploadSessionId);
    const etag = revisionEtag(upload.revision);
    setPrivateRevisionHeaders(response, etag);
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return upload;
  }

  @Delete("file-upload-sessions/:uploadSessionId")
  @HttpCode(204)
  async abortUpload(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("uploadSessionId") uploadSessionId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    await this.uploads.abort(principal.id, uploadSessionId, parseIfMatch(ifMatch));
  }

  @Get("file-upload-sessions/:uploadSessionId/parts")
  listUploadParts(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("uploadSessionId") uploadSessionId: string,
  ) {
    return this.uploads.listParts(principal.id, uploadSessionId);
  }

  @Post("file-upload-sessions/:uploadSessionId/parts/:partNumber")
  @HttpCode(200)
  async signUploadPart(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("uploadSessionId") uploadSessionId: string,
    @Param("partNumber") partNumber: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(signUploadPartRequestSchema)) body: SignUploadPartRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.uploads.signPart(
      principal.id,
      uploadSessionId,
      parsePartNumber(partNumber),
      parseIfMatch(ifMatch),
      body.contentLength,
    );
    response.setHeader("ETag", revisionEtag(result.revision));
    return result.response;
  }

  @Post("file-upload-sessions/:uploadSessionId/complete")
  @HttpCode(202)
  async completeUpload(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("uploadSessionId") uploadSessionId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(completeFileUploadRequestSchema)) body: CompleteFileUploadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.uploads.complete(
      principal.id,
      uploadSessionId,
      parseIfMatch(ifMatch),
      requireIdempotencyKey(idempotencyKey),
      body,
    );
    response.setHeader("ETag", revisionEtag(result.upload.revision));
    response.setHeader("Location", `/api/v1/files/${result.file.id}`);
    return result;
  }
}

export function parseFileStatus(value?: string): Exclude<FileStatus, "deleted"> | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = fileStatusSchema.safeParse(value);
  if (!parsed.success || parsed.data === "deleted") {
    throw validationProblem("status is not a supported File list status");
  }
  return parsed.data;
}

export function parseFileLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

export function parsePartNumber(value: string) {
  const parsed = uploadPartNumberSchema.safeParse(Number(value));
  if (!parsed.success || !/^\d+$/.test(value)) throw validationProblem("partNumber must be an integer between 1 and 10000");
  return parsed.data;
}

export function requireIdempotencyKey(value: string | undefined) {
  if (!value) throw validationProblem("Idempotency-Key is required");
  return value;
}

function setPrivateRevisionHeaders(response: Response, etag: string) {
  response.setHeader("ETag", etag);
  response.setHeader("Cache-Control", "private, no-cache");
}

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createKnowledgeProfileRequestSchema,
  knowledgeProfileIdSchema,
  knowledgeProfileKindSchema,
  knowledgeProfileStatusSchema,
  promoteKnowledgeProfileRequestSchema,
  retireKnowledgeProfileRequestSchema,
  type CreateKnowledgeProfileRequest,
  type KnowledgeProfileKind,
  type PromoteKnowledgeProfileRequest,
  type RetireKnowledgeProfileRequest,
} from "@workbench/workbench-contracts";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { KnowledgeProfilesService } from "./knowledge-profiles.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class KnowledgeProfilesController {
  constructor(private readonly profiles: KnowledgeProfilesService) {}

  @Get("knowledge/profiles")
  @Header("Cache-Control", "private, no-store")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    assertKnownQueryFields(query, ["kind", "status", "cursor", "limit"]);
    return this.profiles.list(
      principal.id,
      parseProfileKind(singleQueryValue("kind", query.kind)),
      parseProfileStatus(singleQueryValue("status", query.status)),
      parseCursor(singleQueryValue("cursor", query.cursor)),
      parseLimit(singleQueryValue("limit", query.limit)),
    );
  }

  @Post("knowledge/profiles")
  @HttpCode(201)
  @Header("Cache-Control", "private, no-store")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(createKnowledgeProfileRequestSchema)) body: CreateKnowledgeProfileRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const profile = await this.profiles.create(principal.id, body);
    response.setHeader("Location", `/api/v1/knowledge/profiles/${profile.kind}/${profile.id}`);
    response.setHeader("Cache-Control", "private, no-store");
    return profile;
  }

  @Get("knowledge/profiles/:profileType/:profileId")
  @Header("Cache-Control", "private, no-store")
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("profileType") rawKind: string,
    @Param("profileId") rawProfileId: string,
  ) {
    return this.profiles.get(
      principal.id,
      parseProfileKind(rawKind),
      parseProfileId(rawProfileId),
    );
  }

  @Post("knowledge/profiles/:profileType/:profileId/promote")
  @Header("Cache-Control", "private, no-store")
  promote(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("profileType") rawKind: string,
    @Param("profileId") rawProfileId: string,
    @Body(new ZodValidationPipe(promoteKnowledgeProfileRequestSchema)) body: PromoteKnowledgeProfileRequest,
  ) {
    return this.profiles.promote(
      principal.id,
      parseProfileKind(rawKind),
      parseProfileId(rawProfileId),
      body,
    );
  }

  @Post("knowledge/profiles/:profileType/:profileId/retire")
  @Header("Cache-Control", "private, no-store")
  retire(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("profileType") rawKind: string,
    @Param("profileId") rawProfileId: string,
    @Body(new ZodValidationPipe(retireKnowledgeProfileRequestSchema)) body: RetireKnowledgeProfileRequest,
  ) {
    return this.profiles.retire(
      principal.id,
      parseProfileKind(rawKind),
      parseProfileId(rawProfileId),
      body,
    );
  }

  @Get("knowledge/profile-adoption-receipts")
  @Header("Cache-Control", "private, no-store")
  listAdoptionReceipts(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    assertKnownQueryFields(query, ["kind", "profileId", "cursor", "limit"]);
    const rawKind = singleQueryValue("kind", query.kind);
    return this.profiles.listAdoptionReceipts(
      principal.id,
      rawKind === undefined ? undefined : parseProfileKind(rawKind),
      parseOptionalProfileId(singleQueryValue("profileId", query.profileId)),
      parseCursor(singleQueryValue("cursor", query.cursor)),
      parseLimit(singleQueryValue("limit", query.limit)),
    );
  }
}

function parseProfileKind(value?: string): KnowledgeProfileKind {
  const parsed = knowledgeProfileKindSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("kind must be embedding or retrieval");
  return parsed.data;
}

function parseProfileStatus(value?: string) {
  if (value === undefined) return undefined;
  const parsed = knowledgeProfileStatusSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("status is not a supported Knowledge Profile status");
  return parsed.data;
}

function parseProfileId(value: string) {
  const parsed = knowledgeProfileIdSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("profileId is not a valid Knowledge Profile id");
  return parsed.data;
}

function parseOptionalProfileId(value?: string) {
  return value === undefined ? undefined : parseProfileId(value);
}

function parseCursor(value?: string) {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(value)) throw validationProblem("cursor is invalid");
  return value;
}

function parseLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

function singleQueryValue(name: string, value?: string | string[]) {
  if (Array.isArray(value)) throw validationProblem(`${name} must be provided at most once`);
  return value;
}

function assertKnownQueryFields(query: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(query).find((key) => !allowed.includes(key));
  if (unknown) throw validationProblem(`Unknown Knowledge Profile query field: ${unknown}`);
}

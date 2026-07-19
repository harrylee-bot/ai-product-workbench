import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createDesignSystemRequestSchema,
  importDesignSystemRequestSchema,
  type CreateDesignSystemRequest,
  type ImportDesignSystemRequest,
} from "@workbench/workbench-contracts";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { DesignSystemImportsService } from "./design-system-imports.service.js";
import { DesignSystemCatalogService } from "./design-system-catalog.service.js";
import { DesignSystemsService } from "./design-systems.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class DesignSystemImportsController {
  constructor(
    private readonly designSystems: DesignSystemsService,
    private readonly imports: DesignSystemImportsService,
    private readonly catalog: DesignSystemCatalogService,
  ) {}

  @Get("workspaces/:workspaceId/design-systems")
  listDesignSystems(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("workspaceId") workspaceId: string,
    @Query("q") query?: string | string[],
    @Query("cursor") cursor?: string | string[],
    @Query("limit") limit?: string | string[],
  ) {
    return this.catalog.list(
      principal.id,
      workspaceId,
      singleQueryValue("q", query),
      singleQueryValue("cursor", cursor),
      parseCatalogLimit(limit),
    );
  }

  @Post("projects/:projectId/design-systems")
  async createDesignSystem(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createDesignSystemRequestSchema)) body: CreateDesignSystemRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const receipt = await this.designSystems.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader(
      "Location",
      `/api/v1/artifacts/${receipt.artifactId}/versions/${receipt.artifactVersionId}`,
    );
    return receipt;
  }

  @Post("projects/:projectId/design-system-imports")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(importDesignSystemRequestSchema)) body: ImportDesignSystemRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const receipt = await this.imports.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader(
      "Location",
      `/api/v1/artifacts/${receipt.targetArtifactId}/versions/${receipt.targetArtifactVersionId}`,
    );
    return receipt;
  }
}

function parseCatalogLimit(value?: string | string[]) {
  value = singleQueryValue("limit", value);
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

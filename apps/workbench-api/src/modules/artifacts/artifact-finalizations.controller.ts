import { Body, Controller, Get, Header, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { confirmArtifactFinalizationRequestSchema as confirmationSchema } from "@workbench/workbench-contracts";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ArtifactFinalizationsService, mapArtifactFinalization } from "./artifact-finalizations.service.js";

@Controller("artifacts/:artifactId/versions/:artifactVersionId/finalization")
@UseGuards(WorkbenchAuthGuard)
export class ArtifactFinalizationsController {
  constructor(private readonly finalizations: ArtifactFinalizationsService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async get(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("artifactId") artifactId: string, @Param("artifactVersionId") versionId: string,
    @Res() response: Response) {
    response.json(mapArtifactFinalization(await this.finalizations.get(principal.id, artifactId, versionId)));
  }

  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async confirm(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("artifactId") artifactId: string, @Param("artifactVersionId") versionId: string,
    @Body(new ZodValidationPipe(confirmationSchema)) body: { checksum: string }) {
    return mapArtifactFinalization(await this.finalizations.confirm(principal.id, artifactId, versionId, body.checksum));
  }

  @Post("retry")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async retry(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("artifactId") artifactId: string, @Param("artifactVersionId") versionId: string) {
    return mapArtifactFinalization(await this.finalizations.retry(principal.id, artifactId, versionId));
  }

  @Post("withdraw")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async withdraw(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("artifactId") artifactId: string, @Param("artifactVersionId") versionId: string) {
    return mapArtifactFinalization(await this.finalizations.withdraw(principal.id, artifactId, versionId));
  }
}

import { Controller, Get, Param, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  runPrototypePatchCheckpointQuerySchema,
} from "@workbench/workbench-contracts";
import type { z } from "zod";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { PrototypePatchCheckpointsService } from "./prototype-patch-checkpoints.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class PrototypePatchCheckpointsController {
  constructor(private readonly checkpoints: PrototypePatchCheckpointsService) {}

  @Get("runs/:runId/artifact-drafts/:artifactVersionId/checkpoint")
  get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Query(new ZodValidationPipe(runPrototypePatchCheckpointQuerySchema))
    query: z.infer<typeof runPrototypePatchCheckpointQuerySchema>,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.checkpoints.get(
      principal.id,
      runId,
      artifactVersionId,
      query.screenId,
    );
  }
}

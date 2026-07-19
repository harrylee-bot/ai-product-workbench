import { Body, Controller, Get, Headers, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  updateCommunicationPreferencesRequestSchema,
  type UpdateCommunicationPreferencesRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CommunicationPreferencesService } from "./communication-preferences.service.js";
import { CurrentPrincipal } from "./current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "./identity.types.js";
import { WorkbenchAuthGuard } from "./workbench-auth.guard.js";

@Controller("identity")
@UseGuards(WorkbenchAuthGuard)
export class IdentityController {
  constructor(private readonly preferences: CommunicationPreferencesService) {}

  @Get("me")
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return principal;
  }

  @Get("preferences")
  async getPreferences(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preferences = await this.preferences.get(principal.id);
    response.setHeader("ETag", revisionEtag(preferences.revision));
    return preferences;
  }

  @Put("preferences")
  async updatePreferences(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(updateCommunicationPreferencesRequestSchema))
    body: UpdateCommunicationPreferencesRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preferences = await this.preferences.update(
      principal.id,
      parseIfMatch(ifMatch),
      body,
    );
    response.setHeader("ETag", revisionEtag(preferences.revision));
    return preferences;
  }
}

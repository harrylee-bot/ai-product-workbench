import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  canvasAgentToolInvocationSchema,
  canvasClientCommandAckRequestSchema,
  canvasClientCommandAckSchema,
  canvasClientStateSyncRequestSchema,
  type CanvasAgentToolInvocation,
  type CanvasClientCommandAckRequest,
  type CanvasClientStateSyncRequest,
} from "@workbench/workbench-contracts";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { httpResponseAbortSignalArgument } from "../../common/http-request-abort.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { CanvasAgentService } from "./canvas-agent.service.js";

@Controller()
export class CanvasAgentController {
  constructor(private readonly canvas: CanvasAgentService) {}

  @Post("runtime/canvas/tools/execute")
  @HttpCode(200)
  execute(
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(canvasAgentToolInvocationSchema)) body: CanvasAgentToolInvocation,
  ) {
    return this.canvas.execute(authorization, idempotencyKey, body);
  }

  @Get("runtime/canvas/visuals/:visualCapabilityId")
  getVisual(
    @Headers("authorization") authorization: string | undefined,
    @Param("visualCapabilityId") visualCapabilityId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.canvas.getVisual(
      authorization,
      visualCapabilityId,
      ifNoneMatch,
      ...httpResponseAbortSignalArgument(response),
    ).then((result) => {
      response.setHeader("Cache-Control", "no-store, private");
      response.setHeader("Content-Type", result.mediaType);
      response.setHeader("Content-Length", String(result.byteSize));
      response.setHeader("ETag", result.etag);
      response.setHeader("X-Content-SHA256", result.sha256);
      response.setHeader("X-Canvas-Visual-Expires-At", result.capabilityExpiresAt.toISOString());
      if (result.notModified) {
        response.status(304);
        return undefined;
      }
      return new StreamableFile(result.body);
    });
  }

  @Get("projects/:projectId/canvas-agent/commands")
  @UseGuards(WorkbenchAuthGuard)
  commands(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("clientSessionId") clientSessionId: string | undefined,
    @Query("projectSessionGeneration") projectSessionGeneration: string | undefined,
    @Query("after") after: string | undefined,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    return this.canvas.listCommands(
      principal.id,
      projectId,
      clientSessionId,
      parsePositiveInteger(projectSessionGeneration),
      after,
      parsePositiveInteger(limit),
    );
  }

  @Put("projects/:projectId/canvas-agent/state")
  @UseGuards(WorkbenchAuthGuard)
  @HttpCode(200)
  synchronizeState(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Body(new ZodValidationPipe(canvasClientStateSyncRequestSchema)) body: CanvasClientStateSyncRequest,
  ) {
    return this.canvas.synchronizeClientState(principal.id, projectId, body);
  }

  @Post("projects/:projectId/canvas-agent/commands/:commandId/ack")
  @UseGuards(WorkbenchAuthGuard)
  @HttpCode(200)
  acknowledge(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Param("commandId") commandId: string,
    @Body(new ZodValidationPipe(canvasClientCommandAckRequestSchema)) body: CanvasClientCommandAckRequest,
  ) {
    return this.canvas.acknowledge(principal.id, projectId, commandId, body);
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

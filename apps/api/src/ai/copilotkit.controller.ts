import { Body, Controller, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { CopilotPrdRuntimeService } from "./copilot-prd-runtime.service";

@Controller("copilotkit")
@UseGuards(JwtAuthGuard)
export class CopilotKitController {
  constructor(private readonly runtime: CopilotPrdRuntimeService) {}

  @Get("info")
  info() {
    return this.runtime.getInfo();
  }

  @Post("agent/:agentId/connect")
  @Throttle({ heavy: { limit: 20, ttl: 60_000 } })
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Param("agentId") agentId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    return this.runtime.connect(user, agentId, body, response);
  }

  @Post("agent/:agentId/run")
  @Throttle({ heavy: { limit: 10, ttl: 60_000 } })
  run(
    @CurrentUser() user: AuthenticatedUser,
    @Param("agentId") agentId: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    return this.runtime.run(user, agentId, body, response);
  }

  @Post("agent/:agentId/stop/:threadId")
  @Throttle({ heavy: { limit: 20, ttl: 60_000 } })
  stop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("agentId") agentId: string,
    @Param("threadId") threadId: string,
  ) {
    return this.runtime.stop(user, agentId, threadId);
  }
}

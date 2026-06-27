import { Body, Controller, Get, Param, Post, Sse, UseGuards } from "@nestjs/common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { CancelVibeRunDto, HandleVibeMessageDto, ConfirmPrdDto } from "./dto";
import { VibeService } from "./vibe.service";

@Controller("ai/vibe")
@UseGuards(JwtAuthGuard)
export class VibeController {
  constructor(private readonly vibeService: VibeService) {}

  @Post("handle-message")
  handleMessage(@CurrentUser() user: AuthenticatedUser, @Body() dto: HandleVibeMessageDto) {
    return this.vibeService.handleMessage(user, dto);
  }

  @Post("confirm-prd")
  confirmPrd(@CurrentUser() user: AuthenticatedUser, @Body() dto: ConfirmPrdDto) {
    return this.vibeService.confirmPrd(user, dto);
  }

  @Get("runs/:runId")
  getRun(@CurrentUser() user: AuthenticatedUser, @Param("runId") runId: string) {
    return this.vibeService.getRun(user, runId);
  }

  @Post("runs/:runId/cancel")
  cancelRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("runId") runId: string,
    @Body() dto: CancelVibeRunDto = {},
  ) {
    return this.vibeService.cancelRun(user, runId, dto.reason);
  }

  @Sse("runs/:runId/stream")
  async streamRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("runId") runId: string,
  ): Promise<Observable<MessageEvent>> {
    await this.vibeService.assertRunAccess(user, runId);
    return this.vibeService.streamRun(runId);
  }
}

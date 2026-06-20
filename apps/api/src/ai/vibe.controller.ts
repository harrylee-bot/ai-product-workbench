import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import { HandleVibeMessageDto } from "./dto";
import { VibeService } from "./vibe.service";

@Controller("ai/vibe")
@UseGuards(JwtAuthGuard)
export class VibeController {
  constructor(private readonly vibeService: VibeService) {}

  @Post("handle-message")
  handleMessage(@CurrentUser() user: AuthenticatedUser, @Body() dto: HandleVibeMessageDto) {
    return this.vibeService.handleMessage(user, dto);
  }
}

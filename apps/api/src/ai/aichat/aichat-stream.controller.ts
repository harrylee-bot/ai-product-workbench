import { Body, Controller, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../auth/auth.types";
import { AichatStreamService } from "./aichat-stream.service";
import { ChatStreamDto } from "./aichat-stream.dto";

/**
 * AI-SDK UIMessageStream 桥端点。
 *
 * 路径（全局前缀 /api 下）：
 * - POST /api/chat/stream      — 创建一轮对话流，返回 AI SDK v6 UIMessageStream
 * - POST /api/chat/:id/stop    — 停止指定 run/会话的运行
 */
@Controller("chat")
@UseGuards(JwtAuthGuard)
export class AichatStreamController {
  constructor(private readonly aichatStream: AichatStreamService) {}

  @Post("stream")
  async stream(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatStreamDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.aichatStream.stream(user, dto, res);
  }

  @Post(":id/stop")
  async stop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.aichatStream.stop(user, id);
  }
}

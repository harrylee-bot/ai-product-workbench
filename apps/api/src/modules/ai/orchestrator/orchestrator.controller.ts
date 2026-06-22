import { Body, Controller, MessageEvent, Param, Post, Sse, UseGuards } from "@nestjs/common";
import { Observable, of } from "rxjs";
import { CurrentUser } from "../../auth/current-user.decorator";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import type { Phase1User } from "../../auth/auth.types";
import { OrchestratorMessageDto } from "./dto";
import { OrchestratorService } from "./orchestrator.service";

@Controller("ai")
@UseGuards(JwtAuthGuard)
export class OrchestratorController {
  constructor(private readonly orchestrator: OrchestratorService) {}

  @Post("orchestrator")
  run(@CurrentUser() user: Phase1User, @Body() dto: OrchestratorMessageDto) {
    return this.orchestrator.handleUserMessage({
      user,
      projectId: dto.projectId,
      conversationId: dto.conversationId,
      content: dto.content,
    });
  }

  @Sse("stream/:conversationId")
  stream(@Param("conversationId") conversationId: string): Observable<MessageEvent> {
    return of({
      data: {
        type: "agent_step",
        content: "decision_engine_ready",
        conversationId,
      },
    });
  }
}

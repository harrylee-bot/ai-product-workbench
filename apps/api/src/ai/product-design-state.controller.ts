import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../common/current-user.decorator";
import {
  AnswerClarificationQuestionDto,
  ApplyStatePatchDto,
  CreateProductDesignStateDto,
  CreateProductDesignVersionDto,
  RollbackProductDesignStateDto,
  UpdateProductDesignStateDto,
} from "./product-design-state.dto";
import { ProductDesignStateService } from "./product-design-state.service";
import type { ProductDesignState } from "./ai-vibe.types";

@Controller("projects/:projectId/product-design-state")
@UseGuards(JwtAuthGuard)
export class ProjectProductDesignStateController {
  constructor(private readonly stateService: ProductDesignStateService) {}

  @Get()
  getCurrent(@CurrentUser() user: AuthenticatedUser, @Param("projectId") projectId: string) {
    return this.stateService.getCurrentStateForUser(user, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("projectId") projectId: string,
    @Body() dto: CreateProductDesignStateDto,
  ) {
    return this.stateService.createStateForUser(user, projectId, {
      title: dto.title,
      businessGoal: dto.businessGoal,
      initialState: dto.initialState as Partial<ProductDesignState> | undefined,
      reason: dto.reason,
    });
  }
}

@Controller("product-design-states")
@UseGuards(JwtAuthGuard)
export class ProductDesignStateResourceController {
  constructor(private readonly stateService: ProductDesignStateService) {}

  @Patch(":stateId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: UpdateProductDesignStateDto,
  ) {
    return this.stateService.updateStateForUser(user, stateId, {
      patch: (dto.patch ?? {}) as Partial<ProductDesignState>,
      reason: dto.reason,
      createVersion: dto.createVersion,
    });
  }

  @Post(":stateId/apply-patch")
  applyPatch(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: ApplyStatePatchDto,
  ) {
    return this.stateService.applyPatchForUser(user, stateId, {
      operations: dto.operations.map((operation) => ({
        ...operation,
        op:
          operation.op === "update"
            ? "replace"
            : operation.op === "delete"
              ? "remove"
              : operation.op,
      })),
      reason: dto.reason,
      runId: dto.runId,
      messageId: dto.messageId,
      createVersion: dto.createVersion,
    });
  }

  @Post(":stateId/versions")
  createVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: CreateProductDesignVersionDto,
  ) {
    return this.stateService.createVersionForUser(user, stateId, dto.reason);
  }

  @Get(":stateId/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("stateId") stateId: string) {
    return this.stateService.listVersionsForUser(user, stateId);
  }

  @Post(":stateId/rollback")
  rollback(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Body() dto: RollbackProductDesignStateDto,
  ) {
    return this.stateService.rollbackForUser(user, stateId, dto);
  }

  @Get(":stateId/change-logs")
  listChangeLogs(@CurrentUser() user: AuthenticatedUser, @Param("stateId") stateId: string) {
    return this.stateService.listChangeLogsForUser(user, stateId);
  }

  @Post(":stateId/assumptions/:assumptionId/confirm")
  confirmAssumption(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("assumptionId") assumptionId: string,
  ) {
    return this.stateService.confirmAssumptionForUser(user, stateId, assumptionId);
  }

  @Post(":stateId/assumptions/:assumptionId/reject")
  rejectAssumption(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("assumptionId") assumptionId: string,
  ) {
    return this.stateService.rejectAssumptionForUser(user, stateId, assumptionId);
  }

  @Post(":stateId/questions/:questionId/answer")
  answerQuestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("stateId") stateId: string,
    @Param("questionId") questionId: string,
    @Body() dto: AnswerClarificationQuestionDto,
  ) {
    return this.stateService.answerQuestionForUser(user, stateId, questionId, dto);
  }
}

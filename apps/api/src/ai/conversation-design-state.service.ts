import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
	import {
	  Prisma,
	  ConversationDesignChangeType,
	  ConversationDesignStateStatus,
	  ConversationStatus,
	  RollbackRecordStatus,
	  RollbackType,
	  UserRole,
	} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  ConversationDesignDraft,
  RequirementDocSection,
  RequirementDocument,
  ConversationDesignState,
  PrototypeSpec,
} from "./ai-vibe.types";
import { conversationStatusFromDesignState } from "./workspace-state-machine";

type StateArrayKey =
  | "targetUsers"
  | "userScenarios"
  | "pages"
  | "features"
  | "backendConfigs"
  | "frontendRules"
  | "businessRules"
  | "stateRules"
  | "exceptionScenarios"
  | "acceptanceCriteria"
  | "assumptions"
  | "knowledgeRefs"
  | "pendingQuestions"
  | "confirmedFacts";

type StateScalarKey = "title" | "summary" | "businessGoal" | "background" | "status";
type StatePathKey = StateArrayKey | StateScalarKey | "prototypeOutline" | "prototypeSpec" | "prdDocument";

type StatePathOperation = "add" | "replace" | "remove" | "append";

type ChangeLogInput = {
  conversationId: string;
  stateId: string;
  changeType: ConversationDesignChangeType;
  path?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  runId?: string;
  messageId?: string;
  createdBy: string;
};

type CreateStateInput = {
  title: string;
  businessGoal?: string;
  initialState?: Partial<ConversationDesignState>;
  reason?: string;
};

type ConversationDesignStateRecord = {
  id: string;
  conversationId: string;
  version: number;
  title: string;
  summary: string | null;
  businessGoal: string;
  background: string | null;
  targetUsers: unknown;
  userScenarios: unknown;
  pages: unknown;
  features: unknown;
  backendConfigs: unknown;
  frontendRules: unknown;
  businessRules: unknown;
  stateRules: unknown;
  exceptionScenarios: unknown;
  acceptanceCriteria: unknown;
  prototypeOutline: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  pendingQuestions: unknown;
  confirmedFacts: unknown;
  prototypeSpec: unknown;
  prdDocument: unknown;
  status: ConversationDesignStateStatus;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ConversationPublishFence = {
  currentDesignStateId: string | null;
  currentDesignStateVersion: number | null;
  currentDesignStateUpdatedAt: string | null;
  currentPrdDocumentId: string | null;
  currentPrototypeArtifactId: string | null;
  latestQaReportId: string | null;
};

type AttachGeneratedArtifactsInput = {
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
  status?: ConversationDesignStateStatus;
  userId?: string;
  reason?: string;
  runId?: string;
  messageId?: string;
  createVersion?: boolean;
  mode?: "current" | "provisional" | "fenced_publish";
  expectedUpdatedAt?: string;
};

@Injectable()
export class ConversationDesignStateService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentState(conversationId: string): Promise<ConversationDesignState | undefined> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { currentDesignStateId: true },
    });
    if (!conversation?.currentDesignStateId) return undefined;
    const state = await this.prisma.conversationDesignState.findFirst({
      where: {
        id: conversation.currentDesignStateId,
        conversationId,
      },
    });
    return state ? this.toStateItem(state as ConversationDesignStateRecord) : undefined;
  }

  async getCurrentStateInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    conversationId: string,
  ): Promise<ConversationDesignState | undefined> {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: { currentDesignStateId: true },
    });
    if (!conversation?.currentDesignStateId) return undefined;
    const state = await tx.conversationDesignState.findFirst({
      where: {
        id: conversation.currentDesignStateId,
        conversationId,
      },
    });
    return state ? this.toStateItem(state as ConversationDesignStateRecord) : undefined;
  }

  async getCurrentStateWithPublishFenceInTransaction(
    tx: Prisma.TransactionClient,
    conversationId: string,
  ): Promise<{
    state: ConversationDesignState | undefined;
    publishFence: ConversationPublishFence;
  }> {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: {
        currentDesignStateId: true,
        currentPrdDocumentId: true,
        currentPrototypeArtifactId: true,
        latestQaReportId: true,
      },
    });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");
    const record = conversation.currentDesignStateId
      ? await tx.conversationDesignState.findFirst({
          where: {
            id: conversation.currentDesignStateId,
            conversationId,
          },
        })
      : null;
    if (conversation.currentDesignStateId && !record) {
      throw new ConflictException("CONVERSATION_CURRENT_STATE_POINTER_INVALID");
    }
    const state = record
      ? this.toStateItem(record as ConversationDesignStateRecord)
      : undefined;
    return {
      state,
      publishFence: {
        currentDesignStateId: conversation.currentDesignStateId,
        currentDesignStateVersion: state?.version ?? null,
        currentDesignStateUpdatedAt: state?.updatedAt ?? null,
        currentPrdDocumentId: conversation.currentPrdDocumentId,
        currentPrototypeArtifactId: conversation.currentPrototypeArtifactId,
        latestQaReportId: conversation.latestQaReportId,
      },
    };
  }

  async getStateByIdForConversation(stateId: string, conversationId: string): Promise<ConversationDesignState | undefined> {
    const state = await this.prisma.conversationDesignState.findFirst({
      where: { id: stateId, conversationId },
    });
    return state ? this.toStateItem(state as ConversationDesignStateRecord) : undefined;
  }

  async getCurrentStateForUser(user: AuthenticatedUser, conversationId: string) {
    await this.assertConversationAccess(user, conversationId, { allowArchived: true });
    const state = await this.getCurrentState(conversationId);
    return { state: state ?? null };
  }

  async createStateForUser(user: AuthenticatedUser, conversationId: string, input: CreateStateInput) {
    const conversation = await this.assertConversationAccess(user, conversationId);
    this.assertOwnerMutation(user, conversation.ownerId);
    const draft = this.createDraftFromInput(conversationId, input);
    const state = await this.createDraft(conversationId, draft, {
      userId: user.id,
      reason: input.reason ?? "用户创建 ConversationDesignState",
    });
    return { state };
  }

  async createVersionForUser(user: AuthenticatedUser, stateId: string, reason?: string) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const state = this.toStateItem(current as ConversationDesignStateRecord);
    const next = {
      ...state,
      version: state.version + 1,
      updatedBy: user.id,
    };
    await this.replaceState(next, {
      userId: user.id,
      changeType: ConversationDesignChangeType.update,
      path: "version",
      before: { version: state.version },
      after: { version: next.version },
      reason: reason ?? "用户手动保存版本",
      createVersion: true,
    });
    const version = await this.prisma.conversationDesignVersion.findFirstOrThrow({
      where: { stateId: next.id, version: next.version },
      orderBy: { createdAt: "desc" },
    });
    return { version: this.toVersionItem(version) };
  }

  async listVersionsForUser(user: AuthenticatedUser, stateId: string) {
    await this.getAccessibleState(user, stateId);
    const items = await this.prisma.conversationDesignVersion.findMany({
      where: { stateId },
      orderBy: { version: "desc" },
    });
    return { items: items.map((item) => this.toVersionItem(item)) };
  }

  async rollbackForUser(
    user: AuthenticatedUser,
    stateId: string,
    input: { versionId: string; reason?: string },
  ) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
	    const previous = this.toStateItem(current as ConversationDesignStateRecord);
	    return this.prisma.$transaction(async (tx) => {
	      const version = await tx.conversationDesignVersion.findFirst({
	        where: { id: input.versionId, stateId },
	      });
	      if (!version) throw new NotFoundException("CONVERSATION_DESIGN_STATE_VERSION_NOT_FOUND");

	      const snapshot = this.normalizeStatePayload(version.snapshot);
	      if (!snapshot) throw new BadRequestException("CONVERSATION_DESIGN_STATE_ROLLBACK_FAILED");

	      const nextVersion = await this.getNextStateVersion(current.conversationId, tx);
	      const updated = await tx.conversationDesignState.update({
	        where: { id: stateId },
	        data: {
	          ...this.toPrismaStateData(snapshot),
	          version: nextVersion,
	          updatedBy: user.id,
	        },
	      });
	      const next = this.toStateItem(updated as ConversationDesignStateRecord);
	      await tx.conversation.update({
	        where: { id: current.conversationId },
	        data: {
	          currentDesignStateId: stateId,
	          status: conversationStatusFromDesignState(next),
	          lastActivityAt: new Date(),
	        },
	      });

	      const reason = input.reason ?? `回滚到版本 ${version.version}`;
	      await this.writeChangeLog({
	        conversationId: next.conversationId,
	        stateId: next.id,
	        changeType: ConversationDesignChangeType.rollback,
	        path: "*",
	        before: previous,
	        after: next,
	        reason,
	        createdBy: user.id,
	      }, tx);
	      const createdVersion = await this.createVersionSnapshot(next, user.id, reason, tx);
	      await tx.rollbackRecord.create({
	        data: {
	          conversationId: next.conversationId,
	          rollbackType: RollbackType.conversation_design_state,
	          fromConversationDesignStateVersion: previous.version,
	          toConversationDesignStateVersion: next.version,
	          beforePrdDocumentId: previous.prdDocument?.id,
	          afterPrdDocumentId: next.prdDocument?.id,
	          beforePrototypeArtifactId: undefined,
	          afterPrototypeArtifactId: undefined,
	          reason,
	          status: RollbackRecordStatus.completed,
	          createdBy: user.id,
	        },
	      });

	      return { state: next, version: this.toVersionItem(createdVersion) };
	    });
	  }

  async restoreVersionSnapshotForConversation(
    conversationId: string,
    targetVersion: number,
    options: { userId: string; reason?: string; runId?: string; messageId?: string },
  ) {
    const current = await this.getCurrentState(conversationId);
    if (!current) throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");
    const version = await this.prisma.conversationDesignVersion.findFirst({
      where: { conversationId, version: targetVersion },
      orderBy: { createdAt: "desc" },
    });
    if (!version) throw new NotFoundException("ROLLBACK_VERSION_NOT_FOUND");

    const snapshot = this.normalizeStatePayload(version.snapshot);
    if (!snapshot) throw new BadRequestException("ROLLBACK_VERSION_INVALID");

    const nextVersion = Math.max(
      current.version + 1,
      await this.getNextStateVersion(conversationId),
    );
    const restored: ConversationDesignState = {
      ...this.cloneState(snapshot),
      id: current.id,
      conversationId,
      version: nextVersion,
      prdDocument: undefined,
      prototypeSpec: undefined,
      status: "design_ready",
      createdBy: current.createdBy,
      createdAt: current.createdAt,
      updatedBy: options.userId,
      updatedAt: new Date().toISOString(),
    };

    const updated = await this.prisma.conversationDesignState.update({
      where: { id: current.id },
      data: {
        version: restored.version,
        ...this.toPrismaStateData(restored),
        prdDocument: Prisma.JsonNull,
        prototypeSpec: Prisma.JsonNull,
        updatedBy: options.userId,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { currentDesignStateId: current.id },
    });

    const next = this.toStateItem(updated as ConversationDesignStateRecord);
    await this.writeChangeLog({
      conversationId,
      stateId: next.id,
      changeType: ConversationDesignChangeType.rollback,
      path: "*",
      before: current,
      after: next,
      reason: options.reason ?? `回滚到 ConversationDesignState v${targetVersion}`,
      runId: options.runId,
      messageId: options.messageId,
      createdBy: options.userId,
    });
    const createdVersion = await this.createVersionSnapshot(
      next,
      options.userId,
      options.reason ?? `回滚到 ConversationDesignState v${targetVersion}`,
    );

    return {
      state: next,
      version: this.toVersionItem(createdVersion),
      fromVersion: current.version,
      targetSnapshotVersion: targetVersion,
    };
  }

  async listChangeLogsForUser(user: AuthenticatedUser, stateId: string) {
    await this.getAccessibleState(user, stateId);
    const items = await this.prisma.conversationDesignChangeLog.findMany({
      where: { stateId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        stateId: item.stateId,
        runId: item.runId ?? undefined,
        messageId: item.messageId ?? undefined,
        changeType: item.changeType,
        path: item.path ?? undefined,
        before: item.before,
        after: item.after,
        reason: item.reason ?? undefined,
        createdBy: item.createdBy,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  async confirmAssumptionForUser(user: AuthenticatedUser, stateId: string, assumptionId: string) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const state = this.toStateItem(current as ConversationDesignStateRecord);
    const index = state.assumptions.findIndex((item) => item.id === assumptionId);
    if (index < 0) throw new NotFoundException("ASSUMPTION_NOT_FOUND");

    const before = state.assumptions[index];
    const nextAssumption = {
      ...before,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
      confirmedBy: user.id,
    };
    state.assumptions[index] = nextAssumption;
    state.version += 1;
    state.confirmedFacts.push({
      id: `confirmed_${assumptionId}`,
      content: String(before.content ?? before.description ?? ""),
      relatedPath: typeof before.relatedPath === "string" ? before.relatedPath : undefined,
      confirmedBy: user.id,
      confirmedAt: new Date().toISOString(),
    });
    this.markSourceConfirmed(state, typeof before.relatedPath === "string" ? before.relatedPath : undefined);

    const updated = await this.replaceState(state, {
      userId: user.id,
      changeType: ConversationDesignChangeType.confirm_assumption,
      path: `assumptions.${assumptionId}`,
      before,
      after: nextAssumption,
      reason: "确认 AI 推断",
      createVersion: true,
    });
    return { state: updated };
  }

  async rejectAssumptionForUser(user: AuthenticatedUser, stateId: string, assumptionId: string) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const state = this.toStateItem(current as ConversationDesignStateRecord);
    const index = state.assumptions.findIndex((item) => item.id === assumptionId);
    if (index < 0) throw new NotFoundException("ASSUMPTION_NOT_FOUND");

    const before = state.assumptions[index];
    const nextAssumption = {
      ...before,
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      rejectedBy: user.id,
    };
    state.assumptions[index] = nextAssumption;
    state.version += 1;

    const updated = await this.replaceState(state, {
      userId: user.id,
      changeType: ConversationDesignChangeType.reject_assumption,
      path: `assumptions.${assumptionId}`,
      before,
      after: nextAssumption,
      reason: "否定 AI 推断",
      createVersion: true,
    });
    return { state: updated };
  }

  async answerQuestionForUser(
    user: AuthenticatedUser,
    stateId: string,
    questionId: string,
    input: { answer: string },
  ) {
    const answer = input.answer?.trim();
    if (!answer) throw new BadRequestException("回答不能为空");

    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.conversation.ownerId);
    const state = this.toStateItem(current as ConversationDesignStateRecord);
    const index = state.pendingQuestions.findIndex((item) => item.id === questionId);
    if (index < 0) throw new NotFoundException("QUESTION_NOT_FOUND");

    const before = state.pendingQuestions[index];
    if (before.status === "answered") throw new BadRequestException("QUESTION_ALREADY_ANSWERED");

    const nextQuestion = {
      ...before,
      status: "answered",
      answer,
      answeredAt: new Date().toISOString(),
      answeredBy: user.id,
    };
    state.pendingQuestions[index] = nextQuestion;
    state.version += 1;
    state.confirmedFacts.push({
      id: `confirmed_question_${questionId}`,
      content: answer,
      relatedPath: typeof before.relatedPath === "string" ? before.relatedPath : undefined,
      confirmedBy: user.id,
      confirmedAt: new Date().toISOString(),
    });
    const relatedPath = typeof before.relatedPath === "string" ? before.relatedPath : undefined;
    if (relatedPath) {
      this.applyValueAtPath(state, relatedPath, answer, "replace");
      this.markSourceConfirmed(state, relatedPath);
    }
    state.status = state.pendingQuestions.some((item) => item.status !== "answered")
      ? "clarifying"
      : "design_ready";

    const updated = await this.replaceState(state, {
      userId: user.id,
      changeType: ConversationDesignChangeType.answer_question,
      path: `pendingQuestions.${questionId}`,
      before,
      after: nextQuestion,
      reason: "回答待确认问题",
      createVersion: true,
    });
    return { state: updated };
  }

  async createDraft(
    conversationId: string,
    draft: ConversationDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string } = {},
  ): Promise<ConversationDesignState> {
    const latest = await this.getCurrentState(conversationId);
    if (latest) {
      return this.updateStateFromDraft(conversationId, latest, draft, options);
    }

    // txn-1：state.create + conversation.update + changeLog + versionSnapshot 原子化，部分失败不留半成品。
    return this.prisma.$transaction(async (tx) => {
      return this.createDraftInTransactionImpl(tx, conversationId, draft, options);
    });
  }

  async createDraftInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    conversationId: string,
    draft: ConversationDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string } = {},
  ): Promise<ConversationDesignState> {
    const latest = await this.getCurrentStateInTransaction(tx, conversationId);
    if (latest) {
      return this.updateStateFromDraftInTransaction(tx, conversationId, latest, draft, options);
    }
    return this.createDraftInTransactionImpl(tx, conversationId, draft, options);
  }

  async createProvisionalDraftInTransaction(
    tx: Prisma.TransactionClient,
    conversationId: string,
    draft: ConversationDesignDraft,
    options: { userId?: string; runId?: string },
  ): Promise<{ state: ConversationDesignState; publishFence: ConversationPublishFence }> {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: {
        currentDesignStateId: true,
        currentPrdDocumentId: true,
        currentPrototypeArtifactId: true,
        latestQaReportId: true,
      },
    });
    if (!conversation) throw new NotFoundException("CONVERSATION_NOT_FOUND");

    const currentRecord = conversation.currentDesignStateId
      ? await tx.conversationDesignState.findFirst({
          where: {
            id: conversation.currentDesignStateId,
            conversationId,
          },
        })
      : null;
    if (conversation.currentDesignStateId && !currentRecord) {
      throw new ConflictException("CONVERSATION_CURRENT_STATE_POINTER_INVALID");
    }
    const current = currentRecord
      ? this.toStateItem(currentRecord as ConversationDesignStateRecord)
      : undefined;
    const nextVersion = await this.getNextStateVersion(conversationId, tx);
    const now = new Date().toISOString();
    const provisional = this.normalizeDraft(conversationId, draft, current);
    provisional.id = "";
    provisional.version = nextVersion;
    provisional.createdBy = options.userId ?? current?.createdBy ?? "system";
    provisional.updatedBy = options.userId;
    provisional.createdAt = now;
    provisional.updatedAt = now;

    const created = await tx.conversationDesignState.create({
      data: {
        conversationId,
        version: nextVersion,
        ...this.toPrismaStateData(provisional),
        prototypeSpec: provisional.prototypeSpec
          ? toInputJson(provisional.prototypeSpec)
          : Prisma.JsonNull,
        prdDocument: provisional.prdDocument
          ? toInputJson(provisional.prdDocument)
          : Prisma.JsonNull,
        createdBy: provisional.createdBy,
        updatedBy: provisional.updatedBy,
      },
    });

    return {
      state: this.toStateItem(created as ConversationDesignStateRecord),
      publishFence: {
        currentDesignStateId: conversation.currentDesignStateId,
        currentDesignStateVersion: current?.version ?? null,
        currentDesignStateUpdatedAt: current?.updatedAt ?? null,
        currentPrdDocumentId: conversation.currentPrdDocumentId,
        currentPrototypeArtifactId: conversation.currentPrototypeArtifactId,
        latestQaReportId: conversation.latestQaReportId,
      },
    };
  }

  private async createDraftInTransactionImpl(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    conversationId: string,
    draft: ConversationDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string },
  ): Promise<ConversationDesignState> {
    const nextVersion = await this.getNextStateVersion(conversationId, tx);
    const state = await tx.conversationDesignState.create({
      data: {
        conversationId,
        version: nextVersion,
        ...this.toPrismaStateData(this.normalizeDraft(conversationId, draft)),
        createdBy: options.userId ?? "system",
        updatedBy: options.userId,
      },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: { currentDesignStateId: state.id },
    });

    const item = this.toStateItem(state as ConversationDesignStateRecord);
    await this.writeChangeLog(
      {
        conversationId,
        stateId: item.id,
        changeType: ConversationDesignChangeType.create,
        path: "*",
        after: item,
        reason: options.reason ?? "首次生成 ConversationDesignState",
        runId: options.runId,
        messageId: options.messageId,
        createdBy: options.userId ?? "system",
      },
      tx,
    );
    await this.createVersionSnapshot(item, options.userId ?? "system", "首次创建状态", tx);
    return item;
  }

  async attachGeneratedArtifacts(
    stateId: string,
    input: AttachGeneratedArtifactsInput,
  ) {
    // txn-1 + race-1：读取、版本校验、写入、changeLog、versionSnapshot 在同一事务内原子完成；
    // 用乐观锁（where id AND version=expected）防止并发覆盖。
    return this.prisma.$transaction(async (tx) => {
      return this.attachGeneratedArtifactsInTransaction(tx, stateId, input);
    });
  }

  async attachGeneratedArtifactsInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    stateId: string,
    input: AttachGeneratedArtifactsInput,
  ) {
    const current = await tx.conversationDesignState.findUnique({ where: { id: stateId } });
    if (!current) throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");
    const before = this.toStateItem(current as ConversationDesignStateRecord);
    const mode = input.mode ?? "current";
    if (mode === "provisional") {
      const conversation = await tx.conversation.findUnique({
        where: { id: before.conversationId },
        select: { currentDesignStateId: true },
      });
      if (!conversation || conversation.currentDesignStateId === stateId) {
        throw new ConflictException("PROVISIONAL_STATE_VISIBILITY_FENCE_REJECTED");
      }
    }

    const prototypeOutline = input.prototypeSpec
      ? toPrototypeOutline(input.prototypeSpec, before.prototypeOutline)
      : before.prototypeOutline;

    // Generated artifacts are derived from this exact semantic state version.
    // Attaching them must not advance the version, otherwise a freshly created
    // PRD/prototype is stale the moment it is saved.
    const result = await tx.conversationDesignState.updateMany({
      where: {
        id: stateId,
        version: before.version,
        updatedAt: input.expectedUpdatedAt
          ? new Date(input.expectedUpdatedAt)
          : current.updatedAt,
      },
      data: {
        prdDocument: input.prdDocument ? toInputJson(input.prdDocument) : undefined,
        prototypeSpec: input.prototypeSpec ? toInputJson(input.prototypeSpec) : undefined,
        prototypeOutline: prototypeOutline ? toInputJson(prototypeOutline) : undefined,
        status: input.status,
        updatedBy: input.userId,
      },
    });
    if (result.count === 0) {
      throw new ConflictException("CONVERSATION_DESIGN_STATE_VERSION_CONFLICT：状态已被并发修改，请重试。");
    }
    const updated = await tx.conversationDesignState.findUnique({ where: { id: stateId } });
    if (!updated) throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");

    const after = this.toStateItem(updated as ConversationDesignStateRecord);
    if (mode === "provisional") return after;
    if (mode === "current") {
      await tx.conversation.update({
        where: { id: after.conversationId },
        data: {
          currentDesignStateId: after.id,
          status: conversationStatusFromDesignState(after),
          lastActivityAt: new Date(),
        },
      });
    }
    await this.writeChangeLog(
      {
        conversationId: after.conversationId,
        stateId: after.id,
        changeType: ConversationDesignChangeType.update,
        path: "generatedArtifacts",
        before: {
          prdDocument: before.prdDocument,
          prototypeSpec: before.prototypeSpec,
          prototypeOutline: before.prototypeOutline,
          status: before.status,
        },
        after: {
          prdDocument: after.prdDocument,
          prototypeSpec: after.prototypeSpec,
          prototypeOutline: after.prototypeOutline,
          status: after.status,
        },
        reason: input.reason ?? "生成 PRD 和 PrototypeSpec 后更新状态",
        runId: input.runId,
        messageId: input.messageId,
        createdBy: input.userId ?? "system",
      },
      tx,
    );
    if (input.createVersion ?? mode === "fenced_publish") {
      await this.createVersionSnapshot(after, input.userId ?? "system", input.reason ?? "生成物更新后保存版本", tx);
    }
    return after;
  }

  async syncRequirementDocumentEdit(input: {
    document: RequirementDocument;
    section: RequirementDocSection;
    userId: string;
    reason?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      return this.syncRequirementDocumentEditInTransaction(tx, input);
    });
  }

  async syncRequirementDocumentEditInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      document: RequirementDocument;
      section: RequirementDocSection;
      userId: string;
      reason?: string;
    },
  ) {
      const currentRecord = await tx.conversationDesignState.findUnique({
        where: { id: input.document.conversationDesignStateId },
      });
      if (!currentRecord) throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");

      const before = this.toStateItem(currentRecord as ConversationDesignStateRecord);
      const next = this.cloneState(before);
      const now = new Date().toISOString();
      const content = prdSectionContent(input.section);
      const changedPaths = content
        ? syncPrdSectionContent(next, input.section, content, input.userId, now)
        : [];

      next.version = Math.max(
        before.version + 1,
        await this.getNextStateVersion(before.conversationId, tx),
      );
      next.status = "doc_ready";
      const versionedDocument: RequirementDocument = {
        ...input.document,
        conversationDesignStateVersion: next.version,
      };
      next.prdDocument = versionedDocument;
      next.prototypeSpec = undefined;
      next.updatedBy = input.userId;
      for (const path of changedPaths) {
        next.confirmedFacts.push({
          id: `confirmed_prd_${input.section.id}_${safeStateFactId(path)}_${Date.now()}`,
          content,
          relatedPath: path,
          confirmedBy: input.userId,
          confirmedAt: now,
          sourceDocumentId: input.document.id,
          sourceSectionId: input.section.id,
        });
        this.markSourceConfirmed(next, path);
      }

      const stateUpdate = await tx.conversationDesignState.updateMany({
        where: { id: before.id, version: before.version },
        data: {
          version: next.version,
          ...this.toPrismaStateData(next),
          prdDocument: toInputJson(versionedDocument),
          prototypeSpec: Prisma.JsonNull,
          updatedBy: input.userId,
        },
      });
      if (stateUpdate.count !== 1) {
        throw new ConflictException("CONVERSATION_DESIGN_STATE_VERSION_CONFLICT：状态已被并发修改，请重试。");
      }
      await tx.requirementDocument.updateMany({
        where: {
          id: input.document.id,
          conversationDesignStateId: before.id,
        },
        data: { conversationDesignStateVersion: next.version },
      });
      const updated = await tx.conversationDesignState.findUnique({ where: { id: before.id } });
      if (!updated) throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");
      const after = this.toStateItem(updated as ConversationDesignStateRecord);
      await tx.conversation.update({
        where: { id: after.conversationId },
        data: {
          currentDesignStateId: after.id,
          currentPrototypeArtifactId: null,
          status: conversationStatusFromDesignState(after),
          lastActivityAt: new Date(),
        },
      });
      await this.writeChangeLog(
        {
          conversationId: after.conversationId,
          stateId: after.id,
          changeType: ConversationDesignChangeType.update,
          path: `prdDocument.sections.${input.section.id}`,
          before: {
            prdDocument: before.prdDocument,
            prototypeSpec: before.prototypeSpec,
            status: before.status,
            changedPaths,
          },
          after: {
            prdDocument: after.prdDocument,
            prototypeSpec: after.prototypeSpec,
            status: after.status,
            changedPaths,
          },
          reason: input.reason ?? `PRD 段落 ${input.section.id} 已回流到 ConversationDesignState`,
          createdBy: input.userId,
        },
        tx,
      );
      await this.createVersionSnapshot(
        after,
        input.userId,
        input.reason ?? `PRD 段落 ${input.section.id} 已回流到 ConversationDesignState`,
        tx,
      );
      return after;
  }

  private async updateStateFromDraft(
    conversationId: string,
    current: ConversationDesignState,
    draft: ConversationDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      return this.updateStateFromDraftInTransaction(tx, conversationId, current, draft, options);
    });
  }

  private async updateStateFromDraftInTransaction(
    tx: Parameters<Parameters<typeof this.prisma.$transaction>[0]>[0],
    conversationId: string,
    current: ConversationDesignState,
    draft: ConversationDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string },
  ) {
    const normalized = this.normalizeDraft(conversationId, draft, current);
    normalized.version = Math.max(
      current.version + 1,
      await this.getNextStateVersion(conversationId, tx),
    );
    normalized.id = current.id;
    normalized.createdAt = current.createdAt;
    normalized.createdBy = current.createdBy;
    const updated = await tx.conversationDesignState.update({
      where: { id: current.id },
      data: {
        version: normalized.version,
        ...this.toPrismaStateData(normalized),
        prototypeSpec: Prisma.JsonNull,
        prdDocument: Prisma.JsonNull,
        updatedBy: options.userId,
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { currentDesignStateId: current.id },
    });
    const after = this.toStateItem(updated as ConversationDesignStateRecord);
    await this.writeChangeLog(
      {
        conversationId,
        stateId: after.id,
        changeType: ConversationDesignChangeType.update,
        path: "*",
        before: current,
        after,
        reason: options.reason ?? "DeerFlow final action 更新 ConversationDesignState",
        runId: options.runId,
        messageId: options.messageId,
        createdBy: options.userId ?? "system",
      },
      tx,
    );
    await this.createVersionSnapshot(after, options.userId ?? "system", options.reason ?? "完整设计更新", tx);
    return after;
  }

  private async replaceState(
    state: ConversationDesignState,
    options: {
      userId: string;
      changeType: ConversationDesignChangeType;
      path: string;
      before?: unknown;
      after?: unknown;
      reason: string;
      createVersion: boolean;
      runId?: string;
      messageId?: string;
    },
  ) {
    // txn-1：update + conversation.update + changeLog + versionSnapshot 原子化。
    return this.prisma.$transaction(async (tx) => {
      state.version = Math.max(
        state.version,
        await this.getNextStateVersion(state.conversationId, tx),
      );
      const updated = await tx.conversationDesignState.update({
        where: { id: state.id },
        data: {
          version: state.version,
          ...this.toPrismaStateData(state),
          updatedBy: options.userId,
        },
      });
      await tx.conversation.update({
        where: { id: state.conversationId },
        data: { currentDesignStateId: state.id },
      });
      const afterState = this.toStateItem(updated as ConversationDesignStateRecord);
      await this.writeChangeLog(
        {
          conversationId: afterState.conversationId,
          stateId: afterState.id,
          changeType: options.changeType,
          path: options.path,
          before: options.before,
          after: options.after ?? afterState,
          reason: options.reason,
          runId: options.runId,
          messageId: options.messageId,
          createdBy: options.userId,
        },
        tx,
      );
      if (options.createVersion) {
        await this.createVersionSnapshot(afterState, options.userId, options.reason, tx);
      }
      return afterState;
    });
  }

  private async createVersionSnapshot(
    state: ConversationDesignState,
    createdBy: string,
    reason?: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const version = await client.conversationDesignVersion.create({
      data: {
        conversationId: state.conversationId,
        stateId: state.id,
        version: state.version,
        snapshot: toInputJson(state),
        reason,
        createdBy,
      },
    });
    await this.writeChangeLog(
      {
        conversationId: state.conversationId,
        stateId: state.id,
        changeType: ConversationDesignChangeType.update,
        path: "version",
        after: { version: state.version },
        reason: reason ? `版本快照：${reason}` : "版本快照",
        createdBy,
      },
      client,
    );
    return version;
  }

  private async writeChangeLog(input: ChangeLogInput, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.conversationDesignChangeLog.create({
      data: {
        conversationId: input.conversationId,
        stateId: input.stateId,
        runId: input.runId,
        messageId: input.messageId,
        changeType: input.changeType,
        path: input.path,
        before: input.before === undefined ? undefined : toInputJson(input.before),
        after: input.after === undefined ? undefined : toInputJson(input.after),
        reason: input.reason,
        createdBy: input.createdBy,
      },
    });
  }

	  private async getNextStateVersion(conversationId: string, tx?: Prisma.TransactionClient) {
	    const client = tx ?? this.prisma;
	    const latest = await client.conversationDesignState.findFirst({
	      where: { conversationId },
	      orderBy: { version: "desc" },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }

  private async assertConversationAccess(
    user: AuthenticatedUser,
    conversationId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || conversation.deletedAt || conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("会话不存在");
    }
    if (!options.allowArchived && conversation.status === ConversationStatus.archived) {
      throw new ForbiddenException("会话已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && conversation.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该会话");
    }
    return conversation;
  }

  private async getAccessibleState(user: AuthenticatedUser, stateId: string) {
    const state = await this.prisma.conversationDesignState.findUnique({
      where: { id: stateId },
      include: { conversation: true },
    });
    if (!state || state.conversation.deletedAt || state.conversation.status === ConversationStatus.deleted) {
      throw new NotFoundException("CONVERSATION_DESIGN_STATE_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && state.conversation.ownerId !== user.id) {
      throw new ForbiddenException("CONVERSATION_DESIGN_STATE_FORBIDDEN");
    }
    return state;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户会话状态");
    }
  }

  private createDraftFromInput(conversationId: string, input: CreateStateInput): ConversationDesignDraft {
    const partial = input.initialState ?? {};
    return {
      title: input.title,
      summary: partial.summary,
      background: partial.background,
      businessGoal: input.businessGoal ?? partial.businessGoal ?? "待补充业务目标",
      targetUsers: partial.targetUsers ?? [],
      userScenarios: partial.userScenarios ?? [],
      pages: partial.pages ?? [],
      features: partial.features ?? [],
      backendConfigs: partial.backendConfigs ?? [],
      frontendRules: partial.frontendRules ?? [],
      businessRules: partial.businessRules ?? [],
      stateRules: partial.stateRules ?? [],
      exceptionScenarios: partial.exceptionScenarios ?? [],
      acceptanceCriteria: partial.acceptanceCriteria ?? [],
      prototypeOutline: partial.prototypeOutline,
      assumptions: partial.assumptions ?? [],
      knowledgeRefs: partial.knowledgeRefs ?? [],
      pendingQuestions: partial.pendingQuestions ?? [],
      confirmedFacts: partial.confirmedFacts ?? [],
      createdBy: partial.createdBy ?? "system",
      updatedBy: partial.updatedBy,
      conversationId,
    } as ConversationDesignDraft;
  }

  private normalizeDraft(
    conversationId: string,
    draft: ConversationDesignDraft,
    existing?: ConversationDesignState,
  ): ConversationDesignState {
    const now = new Date().toISOString();
    const pendingQuestions = normalizeQuestions(draft.pendingQuestions ?? []);
    return {
      id: existing?.id ?? "",
      conversationId,
      version: existing?.version ?? 1,
      title: draft.title || existing?.title || "产品需求方案",
      summary: draft.summary ?? existing?.summary,
      background: draft.background ?? existing?.background,
      businessGoal: draft.businessGoal || existing?.businessGoal || "待补充业务目标",
      targetUsers: normalizeSourcedArray(draft.targetUsers ?? existing?.targetUsers ?? [], "target_user"),
      userScenarios: normalizeSourcedArray(draft.userScenarios ?? existing?.userScenarios ?? [], "scenario"),
      pages: normalizeSourcedArray(draft.pages ?? existing?.pages ?? [], "page"),
      features: normalizeSourcedArray(draft.features ?? existing?.features ?? [], "feature"),
      backendConfigs: normalizeSourcedArray(draft.backendConfigs ?? existing?.backendConfigs ?? [], "config"),
      frontendRules: normalizeSourcedArray(draft.frontendRules ?? existing?.frontendRules ?? [], "display_rule"),
      businessRules: normalizeSourcedArray(draft.businessRules ?? existing?.businessRules ?? [], "business_rule"),
      stateRules: normalizeSourcedArray(draft.stateRules ?? existing?.stateRules ?? [], "state_rule"),
      exceptionScenarios: normalizeSourcedArray(
        draft.exceptionScenarios ?? existing?.exceptionScenarios ?? [],
        "exception",
      ),
      acceptanceCriteria: normalizeSourcedArray(
        draft.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [],
        "acceptance",
      ),
      prototypeOutline: draft.prototypeOutline ?? existing?.prototypeOutline,
      assumptions: normalizeAssumptions(draft.assumptions ?? existing?.assumptions ?? []),
      knowledgeRefs: normalizeKnowledgeRefs(draft.knowledgeRefs ?? existing?.knowledgeRefs ?? []),
      pendingQuestions,
      confirmedFacts: normalizeConfirmedFacts(draft.confirmedFacts ?? existing?.confirmedFacts ?? []),
      prototypeSpec: undefined,
      prdDocument: undefined,
      status: pendingQuestions.length ? "clarifying" : "design_ready",
      createdBy: existing?.createdBy ?? draft.createdBy ?? "system",
      updatedBy: draft.updatedBy ?? existing?.updatedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private cloneState(state: ConversationDesignState): ConversationDesignState {
    return JSON.parse(JSON.stringify(state)) as ConversationDesignState;
  }

  private applyValueAtPath(
    state: ConversationDesignState,
    path: string,
    value: unknown,
    op: StatePathOperation,
  ) {
    const resolved = resolveStatePath(state, path);
    if (!resolved.valid) return false;

    if (resolved.parent === null) {
      if (resolved.key === "id" || resolved.key === "conversationId" || resolved.key === "version") return false;
      if (op === "remove") return false;
      const key = resolved.key as keyof ConversationDesignState;
      if (Array.isArray(state[key])) {
        const current = state[key] as unknown[];
        if (op === "append" || op === "add") {
          current.push(normalizeStatePathValue(value, path, current.length));
        } else {
          (state as Record<string, unknown>)[resolved.key] = Array.isArray(value) ? value : [value];
        }
        return true;
      }
      (state as Record<string, unknown>)[resolved.key] = value;
      return true;
    }

    if (Array.isArray(resolved.parent)) {
      const index = Number(resolved.key);
      if (!Number.isInteger(index) || index < 0) return false;
      if (op === "remove") {
        if (index >= resolved.parent.length) return false;
        resolved.parent.splice(index, 1);
        return true;
      }
      if (op === "append" || op === "add") {
        if (index > resolved.parent.length) return false;
        resolved.parent.splice(index, 0, normalizeStatePathValue(value, path, index));
        return true;
      }
      if (index >= resolved.parent.length) return false;
      resolved.parent[index] = mergeStatePathValue(resolved.parent[index], value);
      return true;
    }

    if (op === "remove") {
      delete resolved.parent[resolved.key];
      return true;
    }
    if (op === "append") {
      const current = resolved.parent[resolved.key];
      if (!Array.isArray(current)) return false;
      current.push(normalizeStatePathValue(value, path, current.length));
      return true;
    }
    resolved.parent[resolved.key] = mergeStatePathValue(resolved.parent[resolved.key], value);
    return true;
  }

  private markSourceConfirmed(state: ConversationDesignState, path?: string) {
    if (!path) return;
    const resolved = resolveStatePath(state, path);
    const target = resolved.valid ? resolved.value : undefined;
    if (target && typeof target === "object" && !Array.isArray(target)) {
      const record = target as Record<string, unknown>;
      record.source = {
        ...(typeof record.source === "object" && record.source ? record.source : {}),
        type: "user_confirmed",
        confidence: 1,
      };
    }
  }

  private normalizeStatePayload(value: unknown): ConversationDesignState | null {
    const record = value && typeof value === "object" ? (value as ConversationDesignState) : null;
    return record?.id && record.conversationId ? record : null;
  }

  private toPrismaStateData(state: ConversationDesignState) {
    return {
      title: state.title,
      summary: state.summary,
      background: state.background,
      businessGoal: state.businessGoal,
      targetUsers: toInputJson(state.targetUsers),
      userScenarios: toInputJson(state.userScenarios),
      pages: toInputJson(state.pages),
      features: toInputJson(state.features),
      backendConfigs: toInputJson(state.backendConfigs),
      frontendRules: toInputJson(state.frontendRules),
      businessRules: toInputJson(state.businessRules),
      stateRules: toInputJson(state.stateRules),
      exceptionScenarios: toInputJson(state.exceptionScenarios),
      acceptanceCriteria: toInputJson(state.acceptanceCriteria),
      prototypeOutline: state.prototypeOutline ? toInputJson(state.prototypeOutline) : Prisma.JsonNull,
      assumptions: toInputJson(state.assumptions),
      knowledgeRefs: toInputJson(state.knowledgeRefs),
      pendingQuestions: toInputJson(state.pendingQuestions),
      confirmedFacts: toInputJson(state.confirmedFacts),
      status: state.status as ConversationDesignStateStatus,
    };
  }

  private toStateItem(state: ConversationDesignStateRecord): ConversationDesignState {
    return {
      id: state.id,
      conversationId: state.conversationId,
      version: state.version,
      title: state.title,
      summary: state.summary ?? undefined,
      businessGoal: state.businessGoal,
      background: state.background ?? undefined,
      targetUsers: this.arrayOf<Record<string, unknown>>(state.targetUsers),
      userScenarios: this.arrayOf<Record<string, unknown>>(state.userScenarios),
      pages: this.arrayOf<Record<string, unknown>>(state.pages),
      features: this.arrayOf<Record<string, unknown>>(state.features),
      backendConfigs: this.arrayOf<Record<string, unknown>>(state.backendConfigs),
      frontendRules: this.arrayOf<Record<string, unknown>>(state.frontendRules),
      businessRules: this.arrayOf<Record<string, unknown>>(state.businessRules),
      stateRules: this.arrayOf<Record<string, unknown>>(state.stateRules),
      exceptionScenarios: this.arrayOf<Record<string, unknown>>(state.exceptionScenarios),
      acceptanceCriteria: this.arrayOf<Record<string, unknown>>(state.acceptanceCriteria),
      prototypeOutline:
        state.prototypeOutline && typeof state.prototypeOutline === "object"
          ? (state.prototypeOutline as Record<string, unknown>)
          : undefined,
      assumptions: this.arrayOf<Record<string, unknown>>(state.assumptions),
      knowledgeRefs: this.arrayOf<Record<string, unknown>>(state.knowledgeRefs),
      pendingQuestions: this.arrayOf<Record<string, unknown>>(state.pendingQuestions),
      confirmedFacts: this.arrayOf<Record<string, unknown>>(state.confirmedFacts),
      prototypeSpec: state.prototypeSpec ? (state.prototypeSpec as PrototypeSpec) : undefined,
      prdDocument: state.prdDocument ? (state.prdDocument as RequirementDocument) : undefined,
      status: state.status,
      createdBy: state.createdBy,
      updatedBy: state.updatedBy ?? undefined,
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    };
  }

  private toVersionItem(version: {
    id: string;
    conversationId: string;
    stateId: string;
    version: number;
    snapshot: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      conversationId: version.conversationId,
      stateId: version.stateId,
      version: version.version,
      snapshot: version.snapshot,
      reason: version.reason ?? undefined,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }

  private toChangeLogItem(log: {
    id: string;
    conversationId: string;
    stateId: string;
    runId: string | null;
    messageId: string | null;
    changeType: ConversationDesignChangeType;
    path: string | null;
    before: unknown;
    after: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: log.id,
      conversationId: log.conversationId,
      stateId: log.stateId,
      runId: log.runId ?? undefined,
      messageId: log.messageId ?? undefined,
      changeType: log.changeType,
      path: log.path ?? undefined,
      before: log.before,
      after: log.after,
      reason: log.reason ?? undefined,
      createdBy: log.createdBy,
      createdAt: log.createdAt.toISOString(),
    };
  }

  private arrayOf<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }
}

function prdSectionContent(section: RequirementDocSection) {
  const content = section.content.trim();
  if (content) return content;
  return (section.blocks ?? [])
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function syncPrdSectionContent(
  state: ConversationDesignState,
  section: RequirementDocSection,
  content: string,
  userId: string,
  now: string,
) {
  const paths = uniqueStrings([
    ...(section.sourcePaths ?? []),
    ...(section.sourceStatePaths ?? []),
    ...(section.blocks ?? []).flatMap((block) => block.sourcePaths ?? []),
  ]);
  const changedPaths: string[] = [];

  for (const path of paths) {
    const normalized = normalizeStatePath(path);
    const root = normalized[0];
    if (!root || !isAllowedRoot(root)) continue;
    if (root === "title") continue;

    if (isScalarPrdPath(root)) {
      (state as Record<string, unknown>)[root] = content;
      changedPaths.push(root);
      continue;
    }

    if (!isArrayPrdPath(root)) continue;
    const rootItems = (state as Record<string, unknown>)[root];
    if (!Array.isArray(rootItems)) continue;

    const revision = manualPrdRevision(root, section, content, userId, now);
    if (normalized.length === 1) {
      rootItems.push(revision);
      changedPaths.push(root);
      continue;
    }

    const resolved = resolveStatePath(state, path);
    if (!resolved.valid) continue;
    if (Array.isArray(resolved.parent)) {
      const index = Number(resolved.key);
      if (!Number.isInteger(index) || index < 0 || index >= resolved.parent.length) continue;
      resolved.parent[index] = mergeStatePathValue(resolved.parent[index], revision);
      changedPaths.push(path);
      continue;
    }
    if (resolved.parent && typeof resolved.parent === "object") {
      const current = resolved.parent[resolved.key];
      resolved.parent[resolved.key] =
        current && typeof current === "object" && !Array.isArray(current)
          ? mergeStatePathValue(current, revision)
          : content;
      changedPaths.push(path);
    }
  }

  return uniqueStrings(changedPaths);
}

function manualPrdRevision(
  rootPath: string,
  section: RequirementDocSection,
  content: string,
  userId: string,
  now: string,
) {
  return {
    id: `manual_${rootPath}_${safeStateFactId(section.id)}_${Date.now()}`,
    title: section.title,
    description: content,
    content,
    relatedSectionId: section.id,
    relatedPath: rootPath,
    source: {
      type: "user_confirmed",
      confidence: 1,
      note: "PRD 局部编辑回流",
    },
    updatedBy: userId,
    updatedAt: now,
  };
}

function isScalarPrdPath(path: string) {
  return path === "summary" || path === "businessGoal" || path === "background";
}

function isArrayPrdPath(path: string) {
  return [
    "targetUsers",
    "userScenarios",
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
    "acceptanceCriteria",
    "assumptions",
    "knowledgeRefs",
    "pendingQuestions",
    "confirmedFacts",
  ].includes(path);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeStateFactId(value: string) {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "path";
}

function normalizeSourcedArray(items: unknown[], prefix: string) {
  return items.map((item, index) => {
    const base: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { name: String(item) };
    return {
      id: typeof base.id === "string" && base.id ? base.id : `${prefix}_${index + 1}`,
      ...base,
      source: normalizeSource(base.source),
    };
  });
}

function normalizeAssumptions(items: unknown[]) {
  return items.map((item, index) => {
    const record: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { content: String(item) };
    return {
      id: typeof record.id === "string" && record.id ? record.id : `assumption_${index + 1}`,
      content: String(record.content ?? record.description ?? ""),
      relatedPath: record.relatedPath,
      confidence: typeof record.confidence === "number" ? record.confidence : 0.7,
      reason: String(record.reason ?? "AI 基于当前需求和通用产品经验推断。"),
      status:
        record.status === "confirmed" || record.status === "rejected" || record.status === "pending"
          ? record.status
          : "pending",
      createdAt:
        typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
      ...record,
    };
  });
}

function normalizeKnowledgeRefs(items: unknown[]) {
  return items.map((item, index) => {
    const record: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { title: String(item) };
    return {
      id: typeof record.id === "string" && record.id ? record.id : `knowledge_ref_${index + 1}`,
      knowledgeId: record.knowledgeId ?? record.sourceId ?? `knowledge_${index + 1}`,
      title: String(record.title ?? "知识引用"),
      snippet: String(record.snippet ?? record.content ?? ""),
      type: normalizeKnowledgeType(record.type ?? record.sourceType),
      relatedPath: record.relatedPath,
      usedByRuntime: record.usedByRuntime,
      ...record,
    };
  });
}

function normalizeQuestions(items: unknown[]) {
  return items.map((item, index) => {
    const record: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { question: String(item) };
    return {
      id: typeof record.id === "string" && record.id ? record.id : `question_${index + 1}`,
      question: String(record.question ?? record.title ?? "请补充确认信息"),
      title: String(record.title ?? record.question ?? "请补充确认信息"),
      reason: String(record.reason ?? "该信息会影响产品设计状态。"),
      required: typeof record.required === "boolean" ? record.required : true,
      options: Array.isArray(record.options) ? record.options.map(String) : undefined,
      recommendation: record.recommendation ?? record.recommendedOption,
      relatedPath: record.relatedPath,
      status:
        record.status === "answered" || record.status === "skipped" || record.status === "pending"
          ? record.status
          : "pending",
      ...record,
    };
  });
}

function normalizeConfirmedFacts(items: unknown[]) {
  return items.map((item, index) => {
    const record: Record<string, unknown> =
      item && typeof item === "object" && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>) }
        : { content: String(item) };
    return {
      id: typeof record.id === "string" && record.id ? record.id : `confirmed_fact_${index + 1}`,
      content: String(record.content ?? ""),
      relatedPath: record.relatedPath,
      confirmedBy: String(record.confirmedBy ?? "system"),
      confirmedAt:
        typeof record.confirmedAt === "string" ? record.confirmedAt : new Date().toISOString(),
      sourceMessageId: record.sourceMessageId,
      ...record,
    };
  });
}

function normalizeSource(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    return {
      type: normalizeSourceType(source.type),
      confidence: typeof source.confidence === "number" ? source.confidence : 0.8,
      knowledgeRefId: source.knowledgeRefId,
      messageId: source.messageId,
      fileId: source.fileId,
      note: source.note,
    };
  }
  if (typeof value === "string") {
    return { type: normalizeSourceType(value), confidence: 0.8 };
  }
  return { type: "ai_assumption", confidence: 0.75 };
}

function normalizeSourceType(value: unknown) {
  const allowed = [
    "user_input",
    "user_confirmed",
    "ai_assumption",
    "knowledge_base",
    "file_extraction",
    "system_default",
  ];
  return typeof value === "string" && allowed.includes(value) ? value : "ai_assumption";
}

function normalizeKnowledgeType(value: unknown) {
  if (
    value === "strong_rule" ||
    value === "default_rule" ||
    value === "reference_case" ||
    value === "design_pattern" ||
    value === "prd_writing_rule" ||
    value === "prototype_rule" ||
    value === "business_concept"
  ) {
    return value;
  }
  if (value === "knowledge_base") return "reference_case";
  return "reference_case";
}

function resolveStatePath(state: ConversationDesignState, path: string) {
  const normalized = normalizeStatePath(path);
  if (!normalized.length) return { valid: false as const };
  if (!isAllowedRoot(normalized[0])) return { valid: false as const };

  let current: unknown = state;
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const segment = normalized[index];
    if (Array.isArray(current)) {
      const arrayIndex = resolveArrayIndex(current, segment);
      if (arrayIndex < 0) return { valid: false as const };
      current = current[arrayIndex];
      continue;
    }
    if (!current || typeof current !== "object") return { valid: false as const };
    current = (current as Record<string, unknown>)[segment];
  }

  const key = normalized.at(-1)!;
  if (normalized.length === 1) {
    return {
      valid: true as const,
      parent: null,
      key,
      value: (state as Record<string, unknown>)[key],
    };
  }
  if (Array.isArray(current)) {
    const index = resolveArrayIndex(current, key);
    return {
      valid: true as const,
      parent: current,
      key: String(index >= 0 ? index : current.length),
      value: index >= 0 ? current[index] : undefined,
    };
  }
  if (!current || typeof current !== "object") return { valid: false as const };
  return {
    valid: true as const,
    parent: current as Record<string, unknown>,
    key,
    value: (current as Record<string, unknown>)[key],
  };
}

function normalizeStatePath(path: string) {
  const normalized = path
    .replace(/^conversationDesignState\.?/i, "")
    .replace(/^state\.?/i, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .trim();
  return normalized
    .split(".")
    .map((segment) => toStatePathKey(segment) ?? segment)
    .filter(Boolean);
}

function toStatePathKey(value: string | undefined): StatePathKey | undefined {
  const aliases: Record<string, StatePathKey> = {
    title: "title",
    summary: "summary",
    businessGoal: "businessGoal",
    business_goal: "businessGoal",
    background: "background",
    targetUsers: "targetUsers",
    target_users: "targetUsers",
    userScenarios: "userScenarios",
    user_scenarios: "userScenarios",
    pages: "pages",
    features: "features",
    backendConfigs: "backendConfigs",
    backend_configs: "backendConfigs",
    frontendRules: "frontendRules",
    frontend_rules: "frontendRules",
    businessRules: "businessRules",
    business_rules: "businessRules",
    stateRules: "stateRules",
    state_rules: "stateRules",
    exceptionScenarios: "exceptionScenarios",
    exception_scenarios: "exceptionScenarios",
    acceptanceCriteria: "acceptanceCriteria",
    acceptance_criteria: "acceptanceCriteria",
    prototypeOutline: "prototypeOutline",
    prototype_outline: "prototypeOutline",
    assumptions: "assumptions",
    knowledgeRefs: "knowledgeRefs",
    knowledge_refs: "knowledgeRefs",
    pendingQuestions: "pendingQuestions",
    pending_questions: "pendingQuestions",
    confirmedFacts: "confirmedFacts",
    confirmed_facts: "confirmedFacts",
    status: "status",
  };
  return value ? aliases[value] : undefined;
}

function isAllowedRoot(value: string) {
  return [
    "title",
    "summary",
    "businessGoal",
    "background",
    "targetUsers",
    "userScenarios",
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
    "acceptanceCriteria",
    "prototypeOutline",
    "assumptions",
    "knowledgeRefs",
    "pendingQuestions",
    "confirmedFacts",
    "status",
  ].includes(value);
}

function resolveArrayIndex(items: unknown[], segment: string) {
  if (/^\d+$/.test(segment)) return Number(segment);
  return items.findIndex((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.id === segment || record.name === segment || record.title === segment;
  });
}

function normalizeStatePathValue(value: unknown, path: string, index: number) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : `state_path_${Date.now()}_${index + 1}`,
      ...record,
      source: record.source ?? { type: "user_input", confidence: 1 },
    };
  }
  return {
    id: `state_path_${Date.now()}_${index + 1}`,
    description: typeof value === "string" ? value : JSON.stringify(value ?? ""),
    source: { type: "user_input", confidence: 1 },
    relatedPath: path,
  };
}

function mergeStatePathValue(current: unknown, value: unknown) {
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return { ...(current as Record<string, unknown>), ...(value as Record<string, unknown>) };
  }
  return value;
}

function toPrototypeOutline(prototypeSpec: PrototypeSpec, previous?: Record<string, unknown>) {
  return {
    targetView: previous?.targetView ?? "both",
    pageIds: prototypeSpec.pages.map((page) => String(page.id ?? "")).filter(Boolean),
    mainInteractions: prototypeSpec.interactions
      .map((interaction) =>
        String(
          interaction.id ??
            interaction.action ??
            interaction.event ??
            interaction.mockResult ??
            "",
        ),
      )
      .filter(Boolean),
    stylePreference: previous?.stylePreference,
    lastPrototypeSpecId: prototypeSpec.id,
    lastPrototypeArtifactId: previous?.lastPrototypeArtifactId,
  };
}

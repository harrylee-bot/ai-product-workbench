import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  ProductDesignChangeType,
  ProductDesignStateStatus,
  ProjectStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  PatchOperation,
  PatchPlan,
  ProductDesignDraft,
  RequirementDocument,
  ProductDesignState,
  PrototypeSpec,
} from "./ai-vibe.types";

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
type PatchKey = StateArrayKey | StateScalarKey | "prototypeOutline" | "prototypeSpec" | "prdDocument";

type NormalizedPatchOperation = {
  op: "add" | "replace" | "remove" | "append";
  path: string;
  value?: unknown;
  reason?: string;
};

type ChangeLogInput = {
  projectId: string;
  stateId: string;
  changeType: ProductDesignChangeType;
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
  initialState?: Partial<ProductDesignState>;
  reason?: string;
};

type UpdateStateInput = {
  patch: Partial<ProductDesignState>;
  reason?: string;
  createVersion?: boolean;
};

type ApplyPatchInput = {
  operations: NormalizedPatchOperation[];
  reason?: string;
  runId?: string;
  messageId?: string;
  createVersion?: boolean;
};

type ProductDesignStateRecord = {
  id: string;
  projectId: string;
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
  status: ProductDesignStateStatus;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ProductDesignStateService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentState(projectId: string): Promise<ProductDesignState | undefined> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        productDesignStates: {
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });

    const state = project?.productDesignStates[0];
    return state ? this.toStateItem(state as ProductDesignStateRecord) : undefined;
  }

  async getStateByIdForProject(stateId: string, projectId: string): Promise<ProductDesignState | undefined> {
    const state = await this.prisma.productDesignState.findFirst({
      where: { id: stateId, projectId },
    });
    return state ? this.toStateItem(state as ProductDesignStateRecord) : undefined;
  }

  async getCurrentStateForUser(user: AuthenticatedUser, projectId: string) {
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const state = await this.getCurrentState(projectId);
    return { state: state ?? null };
  }

  async createStateForUser(user: AuthenticatedUser, projectId: string, input: CreateStateInput) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    const draft = this.createDraftFromInput(projectId, input);
    const state = await this.createDraft(projectId, draft, {
      userId: user.id,
      reason: input.reason ?? "用户创建 ProductDesignState",
    });
    return { state };
  }

  async updateStateForUser(user: AuthenticatedUser, stateId: string, input: UpdateStateInput) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.project.ownerId);

    const updated = await this.updateState(current.id, input.patch, {
      userId: user.id,
      reason: input.reason ?? "用户更新 ProductDesignState",
      createVersion: input.createVersion ?? true,
      changeType: ProductDesignChangeType.update,
    });

    return { state: updated };
  }

  async applyPatchForUser(user: AuthenticatedUser, stateId: string, input: ApplyPatchInput) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.project.ownerId);

    return this.applyPatchOperations(current.id, input.operations, {
      userId: user.id,
      reason: input.reason ?? "用户应用 PatchOperation",
      runId: input.runId,
      messageId: input.messageId,
      createVersion: input.createVersion ?? true,
    });
  }

  async createVersionForUser(user: AuthenticatedUser, stateId: string, reason?: string) {
    const current = await this.getAccessibleState(user, stateId);
    this.assertOwnerMutation(user, current.project.ownerId);
    const state = this.toStateItem(current as ProductDesignStateRecord);
    const next = {
      ...state,
      version: state.version + 1,
      updatedBy: user.id,
    };
    await this.replaceState(next, {
      userId: user.id,
      changeType: ProductDesignChangeType.update,
      path: "version",
      before: { version: state.version },
      after: { version: next.version },
      reason: reason ?? "用户手动保存版本",
      createVersion: true,
    });
    const version = await this.prisma.productDesignVersion.findFirstOrThrow({
      where: { stateId: next.id, version: next.version },
      orderBy: { createdAt: "desc" },
    });
    return { version: this.toVersionItem(version) };
  }

  async listVersionsForUser(user: AuthenticatedUser, stateId: string) {
    await this.getAccessibleState(user, stateId);
    const items = await this.prisma.productDesignVersion.findMany({
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
    this.assertOwnerMutation(user, current.project.ownerId);
    const version = await this.prisma.productDesignVersion.findFirst({
      where: { id: input.versionId, stateId },
    });
    if (!version) throw new NotFoundException("PRODUCT_DESIGN_STATE_VERSION_NOT_FOUND");

    const snapshot = this.normalizeStatePayload(version.snapshot);
    if (!snapshot) throw new BadRequestException("PRODUCT_DESIGN_STATE_ROLLBACK_FAILED");

    const previous = this.toStateItem(current as ProductDesignStateRecord);
    const nextVersion = await this.getNextStateVersion(current.projectId);
    const updated = await this.prisma.productDesignState.update({
      where: { id: stateId },
      data: {
        ...this.toPrismaStateData(snapshot),
        version: nextVersion,
        updatedBy: user.id,
      },
    });
    await this.prisma.project.update({
      where: { id: current.projectId },
      data: { currentProductDesignStateId: stateId },
    });

    const next = this.toStateItem(updated as ProductDesignStateRecord);
    await this.writeChangeLog({
      projectId: next.projectId,
      stateId: next.id,
      changeType: ProductDesignChangeType.rollback,
      path: "*",
      before: previous,
      after: next,
      reason: input.reason ?? `回滚到版本 ${version.version}`,
      createdBy: user.id,
    });
    const createdVersion = await this.createVersionSnapshot(
      next,
      user.id,
      input.reason ?? `回滚到版本 ${version.version}`,
    );

    return { state: next, version: this.toVersionItem(createdVersion) };
  }

  async listChangeLogsForUser(user: AuthenticatedUser, stateId: string) {
    await this.getAccessibleState(user, stateId);
    const items = await this.prisma.productDesignChangeLog.findMany({
      where: { stateId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        projectId: item.projectId,
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
    this.assertOwnerMutation(user, current.project.ownerId);
    const state = this.toStateItem(current as ProductDesignStateRecord);
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
      changeType: ProductDesignChangeType.confirm_assumption,
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
    this.assertOwnerMutation(user, current.project.ownerId);
    const state = this.toStateItem(current as ProductDesignStateRecord);
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
      changeType: ProductDesignChangeType.reject_assumption,
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
    this.assertOwnerMutation(user, current.project.ownerId);
    const state = this.toStateItem(current as ProductDesignStateRecord);
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
      changeType: ProductDesignChangeType.answer_question,
      path: `pendingQuestions.${questionId}`,
      before,
      after: nextQuestion,
      reason: "回答待确认问题",
      createVersion: true,
    });
    return { state: updated };
  }

  async createDraft(
    projectId: string,
    draft: ProductDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string } = {},
  ): Promise<ProductDesignState> {
    const latest = await this.getCurrentState(projectId);
    if (latest) {
      return this.updateStateFromDraft(projectId, latest, draft, options);
    }

    const state = await this.prisma.productDesignState.create({
      data: {
        projectId,
        version: 1,
        ...this.toPrismaStateData(this.normalizeDraft(projectId, draft)),
        createdBy: options.userId ?? "system",
        updatedBy: options.userId,
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentProductDesignStateId: state.id },
    });

    const item = this.toStateItem(state as ProductDesignStateRecord);
    await this.writeChangeLog({
      projectId,
      stateId: item.id,
      changeType: ProductDesignChangeType.create,
      path: "*",
      after: item,
      reason: options.reason ?? "首次生成 ProductDesignState",
      runId: options.runId,
      messageId: options.messageId,
      createdBy: options.userId ?? "system",
    });
    await this.createVersionSnapshot(item, options.userId ?? "system", "首次创建状态");
    return item;
  }

  async attachGeneratedArtifacts(
    stateId: string,
    input: {
      prdDocument?: RequirementDocument;
      prototypeSpec?: PrototypeSpec;
      status?: ProductDesignStateStatus;
      userId?: string;
      reason?: string;
      runId?: string;
      messageId?: string;
      createVersion?: boolean;
    },
  ) {
    const current = await this.prisma.productDesignState.findUnique({ where: { id: stateId } });
    if (!current) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    const before = this.toStateItem(current as ProductDesignStateRecord);

    const prototypeOutline = input.prototypeSpec
      ? toPrototypeOutline(input.prototypeSpec, before.prototypeOutline)
      : before.prototypeOutline;

    const updated = await this.prisma.productDesignState.update({
      where: { id: stateId },
      data: {
        version: before.version + 1,
        prdDocument: input.prdDocument ? toInputJson(input.prdDocument) : undefined,
        prototypeSpec: input.prototypeSpec ? toInputJson(input.prototypeSpec) : undefined,
        prototypeOutline: prototypeOutline ? toInputJson(prototypeOutline) : undefined,
        status: input.status,
        updatedBy: input.userId,
      },
    });

    const after = this.toStateItem(updated as ProductDesignStateRecord);
    await this.writeChangeLog({
      projectId: after.projectId,
      stateId: after.id,
      changeType: ProductDesignChangeType.update,
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
    });
    if (input.createVersion ?? true) {
      await this.createVersionSnapshot(after, input.userId ?? "system", input.reason ?? "生成物更新后保存版本");
    }
    return after;
  }

  async applyPatch(
    projectId: string,
    currentState: ProductDesignState,
    patchPlan: PatchPlan,
    options: { userId?: string; runId?: string; messageId?: string } = {},
  ) {
    const result = await this.applyPatchOperations(
      currentState.id,
      patchPlan.operations.map((operation) => ({
        op: normalizePatchOp(operation.op),
        path: operation.path,
        value: operation.value,
        reason: operation.reason,
      })),
      {
        userId: options.userId ?? "system",
        reason: patchPlan.reason,
        runId: options.runId,
        messageId: options.messageId,
        createVersion: true,
      },
    );
    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentProductDesignStateId: result.state.id },
    });
    return result.state;
  }

  private async updateStateFromDraft(
    projectId: string,
    current: ProductDesignState,
    draft: ProductDesignDraft,
    options: { userId?: string; reason?: string; runId?: string; messageId?: string },
  ) {
    const normalized = this.normalizeDraft(projectId, draft, current);
    normalized.version = current.version + 1;
    normalized.id = current.id;
    normalized.createdAt = current.createdAt;
    normalized.createdBy = current.createdBy;
    const updated = await this.prisma.productDesignState.update({
      where: { id: current.id },
      data: {
        version: normalized.version,
        ...this.toPrismaStateData(normalized),
        prototypeSpec: Prisma.JsonNull,
        prdDocument: Prisma.JsonNull,
        updatedBy: options.userId,
      },
    });
    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentProductDesignStateId: current.id },
    });
    const after = this.toStateItem(updated as ProductDesignStateRecord);
    await this.writeChangeLog({
      projectId,
      stateId: after.id,
      changeType: ProductDesignChangeType.update,
      path: "*",
      before: current,
      after,
      reason: options.reason ?? "Product Designer Agent 更新 ProductDesignState",
      runId: options.runId,
      messageId: options.messageId,
      createdBy: options.userId ?? "system",
    });
    await this.createVersionSnapshot(after, options.userId ?? "system", options.reason ?? "完整设计更新");
    return after;
  }

  private async updateState(
    stateId: string,
    patch: Partial<ProductDesignState>,
    options: {
      userId: string;
      reason: string;
      createVersion: boolean;
      changeType: ProductDesignChangeType;
      runId?: string;
      messageId?: string;
    },
  ) {
    const currentRecord = await this.prisma.productDesignState.findUnique({ where: { id: stateId } });
    if (!currentRecord) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    const current = this.toStateItem(currentRecord as ProductDesignStateRecord);
    const allowedPatch = this.filterStatePatch(patch);
    const next: ProductDesignState = {
      ...current,
      ...allowedPatch,
      version: current.version + 1,
      updatedBy: options.userId,
    };
    return this.replaceState(next, {
      userId: options.userId,
      changeType: options.changeType,
      path: "*",
      before: current,
      after: next,
      reason: options.reason,
      createVersion: options.createVersion,
      runId: options.runId,
      messageId: options.messageId,
    });
  }

  private async applyPatchOperations(
    stateId: string,
    operations: NormalizedPatchOperation[],
    options: {
      userId: string;
      reason: string;
      createVersion: boolean;
      runId?: string;
      messageId?: string;
    },
  ) {
    const currentRecord = await this.prisma.productDesignState.findUnique({ where: { id: stateId } });
    if (!currentRecord) throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    const beforeState = this.toStateItem(currentRecord as ProductDesignStateRecord);
    const next = this.cloneState(beforeState);
    const changeLogs: Awaited<ReturnType<typeof this.writeChangeLog>>[] = [];

    if (!operations.length) throw new BadRequestException("PRODUCT_DESIGN_STATE_INVALID_PATCH");

    for (const operation of operations) {
      const normalizedOp = normalizePatchOp(operation.op);
      const before = this.readValueAtPath(next, operation.path);
      const changed = this.applyValueAtPath(next, operation.path, operation.value, normalizedOp);
      const after = this.readValueAtPath(next, operation.path);
      if (!changed) throw new BadRequestException("INVALID_PATCH_PATH");
      changeLogs.push(
        await this.writeChangeLog({
          projectId: next.projectId,
          stateId: next.id,
          changeType: ProductDesignChangeType.patch,
          path: operation.path,
          before,
          after,
          reason: operation.reason ?? options.reason,
          runId: options.runId,
          messageId: options.messageId,
          createdBy: options.userId,
        }),
      );
    }

    next.version = beforeState.version + 1;
    next.status = "patching";
    next.prototypeSpec = undefined;
    next.prdDocument = undefined;
    next.updatedBy = options.userId;

    const updated = await this.prisma.productDesignState.update({
      where: { id: stateId },
      data: {
        version: next.version,
        ...this.toPrismaStateData(next),
        prototypeSpec: Prisma.JsonNull,
        prdDocument: Prisma.JsonNull,
        updatedBy: options.userId,
      },
    });
    await this.prisma.project.update({
      where: { id: next.projectId },
      data: { currentProductDesignStateId: stateId },
    });
    const state = this.toStateItem(updated as ProductDesignStateRecord);
    const version = options.createVersion
      ? await this.createVersionSnapshot(state, options.userId, options.reason)
      : undefined;
    return {
      state,
      changeLogs: changeLogs.map((item) => this.toChangeLogItem(item)),
      version: version ? this.toVersionItem(version) : undefined,
    };
  }

  private async replaceState(
    state: ProductDesignState,
    options: {
      userId: string;
      changeType: ProductDesignChangeType;
      path: string;
      before?: unknown;
      after?: unknown;
      reason: string;
      createVersion: boolean;
      runId?: string;
      messageId?: string;
    },
  ) {
    const updated = await this.prisma.productDesignState.update({
      where: { id: state.id },
      data: {
        version: state.version,
        ...this.toPrismaStateData(state),
        updatedBy: options.userId,
      },
    });
    await this.prisma.project.update({
      where: { id: state.projectId },
      data: { currentProductDesignStateId: state.id },
    });
    const afterState = this.toStateItem(updated as ProductDesignStateRecord);
    await this.writeChangeLog({
      projectId: afterState.projectId,
      stateId: afterState.id,
      changeType: options.changeType,
      path: options.path,
      before: options.before,
      after: options.after ?? afterState,
      reason: options.reason,
      runId: options.runId,
      messageId: options.messageId,
      createdBy: options.userId,
    });
    if (options.createVersion) {
      await this.createVersionSnapshot(afterState, options.userId, options.reason);
    }
    return afterState;
  }

  private async createVersionSnapshot(state: ProductDesignState, createdBy: string, reason?: string) {
    const version = await this.prisma.productDesignVersion.create({
      data: {
        projectId: state.projectId,
        stateId: state.id,
        version: state.version,
        snapshot: toInputJson(state),
        reason,
        createdBy,
      },
    });
    await this.writeChangeLog({
      projectId: state.projectId,
      stateId: state.id,
      changeType: ProductDesignChangeType.update,
      path: "version",
      after: { version: state.version },
      reason: reason ? `版本快照：${reason}` : "版本快照",
      createdBy,
    });
    return version;
  }

  private async writeChangeLog(input: ChangeLogInput) {
    return this.prisma.productDesignChangeLog.create({
      data: {
        projectId: input.projectId,
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

  private async getNextStateVersion(projectId: string) {
    const latest = await this.prisma.productDesignState.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  }

  private async assertProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("你无权访问该项目");
    }
    return project;
  }

  private async getAccessibleState(user: AuthenticatedUser, stateId: string) {
    const state = await this.prisma.productDesignState.findUnique({
      where: { id: stateId },
      include: { project: true },
    });
    if (!state || state.project.deletedAt || state.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("PRODUCT_DESIGN_STATE_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && state.project.ownerId !== user.id) {
      throw new ForbiddenException("PRODUCT_DESIGN_STATE_FORBIDDEN");
    }
    return state;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目状态");
    }
  }

  private createDraftFromInput(projectId: string, input: CreateStateInput): ProductDesignDraft {
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
      projectId,
    } as ProductDesignDraft;
  }

  private normalizeDraft(
    projectId: string,
    draft: ProductDesignDraft,
    existing?: ProductDesignState,
  ): ProductDesignState {
    const now = new Date().toISOString();
    const pendingQuestions = normalizeQuestions(draft.pendingQuestions ?? []);
    return {
      id: existing?.id ?? "",
      projectId,
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

  private filterStatePatch(patch: Partial<ProductDesignState>) {
    const allowed: Partial<ProductDesignState> = {};
    const keys: PatchKey[] = [
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
    ];
    keys.forEach((key) => {
      if (patch[key as keyof ProductDesignState] !== undefined) {
        (allowed as Record<string, unknown>)[key] = patch[key as keyof ProductDesignState];
      }
    });
    return allowed;
  }

  private cloneState(state: ProductDesignState): ProductDesignState {
    return JSON.parse(JSON.stringify(state)) as ProductDesignState;
  }

  private readValueAtPath(state: ProductDesignState, path: string) {
    const resolved = resolveStatePath(state, path);
    return resolved.valid ? resolved.value : undefined;
  }

  private applyValueAtPath(
    state: ProductDesignState,
    path: string,
    value: unknown,
    op: NormalizedPatchOperation["op"],
  ) {
    const resolved = resolveStatePath(state, path);
    if (!resolved.valid) return false;

    if (resolved.parent === null) {
      if (resolved.key === "id" || resolved.key === "projectId" || resolved.key === "version") return false;
      if (op === "remove") return false;
      const key = resolved.key as keyof ProductDesignState;
      if (Array.isArray(state[key])) {
        const current = state[key] as unknown[];
        if (op === "append" || op === "add") {
          current.push(normalizePatchValue(value, path, current.length));
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
        resolved.parent.splice(index, 0, normalizePatchValue(value, path, index));
        return true;
      }
      if (index >= resolved.parent.length) return false;
      resolved.parent[index] = mergePatchValue(resolved.parent[index], value);
      return true;
    }

    if (op === "remove") {
      delete resolved.parent[resolved.key];
      return true;
    }
    if (op === "append") {
      const current = resolved.parent[resolved.key];
      if (!Array.isArray(current)) return false;
      current.push(normalizePatchValue(value, path, current.length));
      return true;
    }
    resolved.parent[resolved.key] = mergePatchValue(resolved.parent[resolved.key], value);
    return true;
  }

  private markSourceConfirmed(state: ProductDesignState, path?: string) {
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

  private normalizeStatePayload(value: unknown): ProductDesignState | null {
    const record = value && typeof value === "object" ? (value as ProductDesignState) : null;
    return record?.id && record.projectId ? record : null;
  }

  private toPrismaStateData(state: ProductDesignState) {
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
      status: state.status as ProductDesignStateStatus,
    };
  }

  private toStateItem(state: ProductDesignStateRecord): ProductDesignState {
    return {
      id: state.id,
      projectId: state.projectId,
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
    projectId: string;
    stateId: string;
    version: number;
    snapshot: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: version.id,
      projectId: version.projectId,
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
    projectId: string;
    stateId: string;
    runId: string | null;
    messageId: string | null;
    changeType: ProductDesignChangeType;
    path: string | null;
    before: unknown;
    after: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }) {
    return {
      id: log.id,
      projectId: log.projectId,
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

function normalizePatchOp(op: PatchOperation["op"] | NormalizedPatchOperation["op"] | string) {
  if (op === "update" || op === "replace") return "replace";
  if (op === "delete" || op === "remove") return "remove";
  if (op === "append") return "append";
  return "add";
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
    value === "design_pattern"
  ) {
    return value;
  }
  if (value === "knowledge_base") return "reference_case";
  return "reference_case";
}

function resolveStatePath(state: ProductDesignState, path: string) {
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
    .replace(/^productDesignState\.?/i, "")
    .replace(/^state\.?/i, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .trim();
  return normalized
    .split(".")
    .map((segment) => toStatePathKey(segment) ?? segment)
    .filter(Boolean);
}

function toStatePathKey(value: string | undefined): PatchKey | undefined {
  const aliases: Record<string, PatchKey> = {
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

function normalizePatchValue(value: unknown, path: string, index: number) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      id: typeof record.id === "string" ? record.id : `patch_${Date.now()}_${index + 1}`,
      ...record,
      source: record.source ?? { type: "user_input", confidence: 1 },
    };
  }
  return {
    id: `patch_${Date.now()}_${index + 1}`,
    description: typeof value === "string" ? value : JSON.stringify(value ?? ""),
    source: { type: "user_input", confidence: 1 },
    relatedPath: path,
  };
}

function mergePatchValue(current: unknown, value: unknown) {
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

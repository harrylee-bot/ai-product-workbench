import { Injectable } from "@nestjs/common";
import { ProductDesignStateStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  PatchOperation,
  PatchPlan,
  ProductDesignDraft,
  ProductDesignState,
  PrototypeSpec,
  RequirementDocumentDraft,
} from "./ai-vibe.types";

type PatchArrayKey =
  | "pages"
  | "features"
  | "backendConfigs"
  | "frontendRules"
  | "businessRules"
  | "stateRules"
  | "exceptionScenarios"
  | "acceptanceCriteria"
  | "assumptions";

type PatchScalarKey = "title" | "businessGoal" | "background";

type NormalizedPatchTarget =
  | { kind: "scalar"; key: PatchScalarKey }
  | { kind: "array"; key: PatchArrayKey; index?: number };

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
    return state ? this.toStateItem(state) : undefined;
  }

  async createDraft(projectId: string, draft: ProductDesignDraft): Promise<ProductDesignState> {
    const latest = await this.prisma.productDesignState.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    const version = (latest?.version ?? 0) + 1;

    const state = await this.prisma.productDesignState.create({
      data: {
        projectId,
        version,
        title: draft.title,
        businessGoal: draft.businessGoal,
        background: draft.background,
        targetUsers: toInputJson(draft.targetUsers),
        userScenarios: toInputJson(draft.userScenarios),
        pages: toInputJson(draft.pages),
        features: toInputJson(draft.features),
        backendConfigs: toInputJson(draft.backendConfigs),
        frontendRules: toInputJson(draft.frontendRules),
        businessRules: toInputJson(draft.businessRules),
        stateRules: toInputJson(draft.stateRules),
        exceptionScenarios: toInputJson(draft.exceptionScenarios),
        acceptanceCriteria: toInputJson(draft.acceptanceCriteria),
        assumptions: toInputJson(draft.assumptions),
        knowledgeRefs: toInputJson(draft.knowledgeRefs),
        pendingQuestions: toInputJson(draft.pendingQuestions),
        status: draft.pendingQuestions.length
          ? ProductDesignStateStatus.clarifying
          : ProductDesignStateStatus.design_ready,
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentProductDesignStateId: state.id },
    });

    return this.toStateItem(state);
  }

  async attachGeneratedArtifacts(
    stateId: string,
    input: {
      prdDocument?: RequirementDocumentDraft;
      prototypeSpec?: PrototypeSpec;
      status?: ProductDesignStateStatus;
    },
  ) {
    const updated = await this.prisma.productDesignState.update({
      where: { id: stateId },
      data: {
        prdDocument: input.prdDocument ? toInputJson(input.prdDocument) : undefined,
        prototypeSpec: input.prototypeSpec ? toInputJson(input.prototypeSpec) : undefined,
        status: input.status,
      },
    });

    return this.toStateItem(updated);
  }

  async applyPatch(projectId: string, currentState: ProductDesignState, patchPlan: PatchPlan) {
    const patchedState = this.applyPatchOperations(currentState, patchPlan);
    const latest = await this.prisma.productDesignState.findFirst({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    const version = Math.max(latest?.version ?? currentState.version, currentState.version) + 1;

    const state = await this.prisma.productDesignState.create({
      data: {
        projectId,
        version,
        title: patchedState.title,
        businessGoal: patchedState.businessGoal,
        background: patchedState.background,
        targetUsers: toInputJson(patchedState.targetUsers),
        userScenarios: toInputJson(patchedState.userScenarios),
        pages: toInputJson(patchedState.pages),
        features: toInputJson(patchedState.features),
        backendConfigs: toInputJson(patchedState.backendConfigs),
        frontendRules: toInputJson(patchedState.frontendRules),
        businessRules: toInputJson(patchedState.businessRules),
        stateRules: toInputJson(patchedState.stateRules),
        exceptionScenarios: toInputJson(patchedState.exceptionScenarios),
        acceptanceCriteria: toInputJson(patchedState.acceptanceCriteria),
        assumptions: toInputJson(patchedState.assumptions),
        knowledgeRefs: toInputJson(patchedState.knowledgeRefs),
        pendingQuestions: toInputJson(patchedState.pendingQuestions),
        prototypeSpec: patchedState.prototypeSpec ? toInputJson(patchedState.prototypeSpec) : undefined,
        prdDocument: patchedState.prdDocument ? toInputJson(patchedState.prdDocument) : undefined,
        status: ProductDesignStateStatus.patching,
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { currentProductDesignStateId: state.id },
    });

    return this.toStateItem(state);
  }

  private applyPatchOperations(state: ProductDesignState, patchPlan: PatchPlan): ProductDesignState {
    const next: ProductDesignState = {
      ...state,
      targetUsers: [...state.targetUsers],
      userScenarios: [...state.userScenarios],
      pages: [...state.pages],
      features: [...state.features],
      backendConfigs: [...state.backendConfigs],
      frontendRules: [...state.frontendRules],
      businessRules: [...state.businessRules],
      stateRules: [...state.stateRules],
      exceptionScenarios: [...state.exceptionScenarios],
      acceptanceCriteria: [...state.acceptanceCriteria],
      assumptions: [...state.assumptions],
      knowledgeRefs: [...state.knowledgeRefs],
      pendingQuestions: [...state.pendingQuestions],
    };

    let applied = false;

    patchPlan.operations.forEach((operation) => {
      const normalizedOp = normalizePatchOp(operation.op);
      const target = normalizePatchPath(operation.path);
      if (!target) return;

      if (target.kind === "scalar") {
        if (normalizedOp === "delete") return;
        const value = typeof operation.value === "string" ? operation.value : JSON.stringify(operation.value ?? "");
        next[target.key] = value;
        applied = true;
        return;
      }

      const list = next[target.key];
      if (normalizedOp === "delete") {
        if (target.index === undefined) return;
        list.splice(target.index, 1);
        applied = true;
        return;
      }

      const patchValue = toPatchObject(operation.value, operation.reason, patchPlan.reason);
      if (normalizedOp === "update" && target.index !== undefined && list[target.index]) {
        list[target.index] = {
          ...list[target.index],
          ...patchValue,
          patchedAt: new Date().toISOString(),
        };
        applied = true;
        return;
      }

      list.push({
        id: typeof patchValue.id === "string" ? patchValue.id : `patch_${Date.now()}_${list.length + 1}`,
        ...patchValue,
        patchReason: operation.reason,
        patchedAt: new Date().toISOString(),
      });
      applied = true;
    });

    if (!applied) {
      const fallbackKey: PatchArrayKey =
        patchPlan.patchType === "prototype" ? "frontendRules" : "businessRules";
      next[fallbackKey].push({
        id: `patch_${Date.now()}_${next[fallbackKey].length + 1}`,
        description: patchPlan.reason,
        source: "patch_plan",
        patchReason: "PatchPlan did not contain an allowed ProductDesignState path.",
        patchedAt: new Date().toISOString(),
      });
    }

    next.status = "patching";
    next.prototypeSpec = undefined;
    next.prdDocument = undefined;
    return next;
  }

  private toStateItem(state: {
    id: string;
    projectId: string;
    version: number;
    title: string;
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
    assumptions: unknown;
    knowledgeRefs: unknown;
    pendingQuestions: unknown;
    prototypeSpec: unknown;
    prdDocument: unknown;
    status: ProductDesignStateStatus;
    createdAt: Date;
    updatedAt: Date;
  }): ProductDesignState {
    return {
      id: state.id,
      projectId: state.projectId,
      version: state.version,
      title: state.title,
      businessGoal: state.businessGoal,
      background: state.background ?? undefined,
      targetUsers: this.arrayOf<string>(state.targetUsers),
      userScenarios: this.arrayOf<string>(state.userScenarios),
      pages: this.arrayOf<Record<string, unknown>>(state.pages),
      features: this.arrayOf<Record<string, unknown>>(state.features),
      backendConfigs: this.arrayOf<Record<string, unknown>>(state.backendConfigs),
      frontendRules: this.arrayOf<Record<string, unknown>>(state.frontendRules),
      businessRules: this.arrayOf<Record<string, unknown>>(state.businessRules),
      stateRules: this.arrayOf<Record<string, unknown>>(state.stateRules),
      exceptionScenarios: this.arrayOf<Record<string, unknown>>(state.exceptionScenarios),
      acceptanceCriteria: this.arrayOf<Record<string, unknown>>(state.acceptanceCriteria),
      assumptions: this.arrayOf<Record<string, unknown>>(state.assumptions),
      knowledgeRefs: this.arrayOf(state.knowledgeRefs),
      pendingQuestions: this.arrayOf(state.pendingQuestions),
      prototypeSpec: state.prototypeSpec ? (state.prototypeSpec as PrototypeSpec) : undefined,
      prdDocument: state.prdDocument ? (state.prdDocument as RequirementDocumentDraft) : undefined,
      status: state.status,
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    };
  }

  private arrayOf<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }
}

function normalizePatchOp(op: PatchOperation["op"] | string): PatchOperation["op"] {
  if (op === "update" || op === "replace") return "update";
  if (op === "delete" || op === "remove") return "delete";
  return "add";
}

function normalizePatchPath(path: string): NormalizedPatchTarget | null {
  const normalized = path
    .replace(/^productDesignState\.?/i, "")
    .replace(/^state\.?/i, "")
    .replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter(Boolean);
  const key = toStatePathKey(segments[0]);
  if (!key) return null;

  if (isPatchScalarKey(key)) return { kind: "scalar", key };
  if (!isPatchArrayKey(key)) return null;

  const indexSegment = segments.find((segment) => /^\d+$/.test(segment));
  return {
    kind: "array",
    key,
    index: indexSegment ? Number(indexSegment) : undefined,
  };
}

function toStatePathKey(value: string | undefined) {
  const aliases: Record<string, PatchArrayKey | PatchScalarKey> = {
    title: "title",
    businessGoal: "businessGoal",
    business_goal: "businessGoal",
    background: "background",
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
    assumptions: "assumptions",
  };
  return value ? aliases[value] : undefined;
}

function isPatchScalarKey(value: string): value is PatchScalarKey {
  return value === "title" || value === "businessGoal" || value === "background";
}

function isPatchArrayKey(value: string): value is PatchArrayKey {
  return [
    "pages",
    "features",
    "backendConfigs",
    "frontendRules",
    "businessRules",
    "stateRules",
    "exceptionScenarios",
    "acceptanceCriteria",
    "assumptions",
  ].includes(value);
}

function toPatchObject(value: unknown, operationReason: string, planReason: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {
    description: typeof value === "string" && value.trim() ? value : operationReason || planReason,
    source: "patch_operation",
  };
}

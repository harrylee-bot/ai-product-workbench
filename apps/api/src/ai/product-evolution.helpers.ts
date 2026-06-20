import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ProjectStatus, UserRole } from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { toInputJson } from "./ai-vibe.helpers";
import type { ProductDesignState } from "./ai-vibe.types";
import type {
  EvolutionPatchOperation,
  EvolutionPriority,
  InsightIssueType,
  InsightSeverity,
  ProductInteractionEventItem,
} from "./product-evolution.types";

export const ALLOWED_STATE_ROOTS = [
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
] as const;

export type ProjectAccessDelegate = {
  project: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      ownerId: string;
      status: ProjectStatus;
      deletedAt: Date | null;
      currentConversationId?: string | null;
    } | null>;
  };
};

export async function assertProjectAccess(
  prisma: ProjectAccessDelegate,
  user: AuthenticatedUser,
  projectId: string,
  options: { allowArchived?: boolean } = {},
) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
    throw new NotFoundException("项目不存在");
  }
  if (!options.allowArchived && project.status === ProjectStatus.archived) {
    throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
  }
  if (user.role !== UserRole.admin && project.ownerId !== user.id) {
    throw new ForbiddenException("PROJECT_FORBIDDEN");
  }
  return project;
}

export function assertOwnerMutation(user: AuthenticatedUser, ownerId: string, message: string) {
  if (user.role === UserRole.admin && user.id !== ownerId) {
    throw new ForbiddenException(message);
  }
}

export function normalizeStatePath(path: string) {
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

export function assertStateOnlyPatchOperations(operations: EvolutionPatchOperation[]) {
  if (!operations.length) throw new BadRequestException("EVOLUTION_PLAN_EMPTY_PATCH");
  operations.forEach((operation) => {
    if (!["add", "update", "delete"].includes(operation.type)) {
      throw new BadRequestException("PATCH_OPERATION_TYPE_INVALID");
    }
    const segments = normalizeStatePath(operation.targetPath);
    const root = segments[0];
    if (!root || !ALLOWED_STATE_ROOTS.includes(root as (typeof ALLOWED_STATE_ROOTS)[number])) {
      throw new BadRequestException("PATCH_TARGET_MUST_BE_PRODUCT_DESIGN_STATE");
    }
    if (["id", "projectId", "version", "prdDocument", "prototypeSpec"].includes(root)) {
      throw new BadRequestException("PATCH_TARGET_FORBIDDEN");
    }
    if (/^(prd|prototype|html|requirementDocument|prototypeArtifact)\b/i.test(operation.targetPath)) {
      throw new BadRequestException("PATCH_CANNOT_MODIFY_RENDERED_ARTIFACTS");
    }
  });
}

export function toPatchPlanOperation(operation: EvolutionPatchOperation) {
  return {
    op: operation.type === "delete" ? "remove" as const : operation.type === "update" ? "replace" as const : "add" as const,
    path: normalizeStatePath(operation.targetPath).join("."),
    value: operation.value,
    reason: operation.reason ?? "EvolutionPlan PatchOperation",
  };
}

export function normalizeIssueType(value: unknown): InsightIssueType {
  if (value === "logic" || value === "flow" || value === "content") return value;
  return "ux";
}

export function normalizeSeverity(value: unknown): InsightSeverity {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

export function normalizePriority(value: unknown): EvolutionPriority {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

export function json(value: unknown) {
  return value === undefined ? undefined : toInputJson(value);
}

export function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function stateSummary(state: ProductDesignState) {
  return {
    id: state.id,
    projectId: state.projectId,
    version: state.version,
    title: state.title,
    status: state.status,
    counts: {
      pages: state.pages.length,
      features: state.features.length,
      businessRules: state.businessRules.length,
      frontendRules: state.frontendRules.length,
      acceptanceCriteria: state.acceptanceCriteria.length,
      pendingQuestions: state.pendingQuestions.length,
    },
    updatedAt: state.updatedAt,
  };
}

export function interactionContentSummary(events: ProductInteractionEventItem[]) {
  return events
    .map((event, index) => {
      const content = event.content?.trim() || JSON.stringify(event.metadata ?? {});
      return `${index + 1}. [${event.type}/${event.targetType}] ${content.slice(0, 500)}`;
    })
    .join("\n");
}

function toStatePathKey(value: string | undefined): string | undefined {
  const aliases: Record<string, string> = {
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

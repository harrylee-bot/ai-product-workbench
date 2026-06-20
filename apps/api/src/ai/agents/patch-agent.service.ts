import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type {
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  RequirementDocument,
  SelectedRegion,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PatchAgentInput = {
  userInput: string;
  selectedRegion: SelectedRegion;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocument;
  prototypeSpec?: PrototypeSpec;
};

@Injectable()
export class PatchAgentService extends BaseAgentService<PatchAgentInput, PatchPlan> {
  readonly agentName = AgentName.patch_agent;
  readonly taskType = ModelTaskType.patch_planning;

  constructor(modelGateway: ModelGatewayService) {
    super(modelGateway);
  }

  protected buildMessages(input: PatchAgentInput) {
    return [
      {
        role: "system" as const,
        content:
          "你是 Patch Agent。只能输出 PatchPlan JSON，不能直接输出 PRD 或 HTML。必须先判断修改意图、影响范围和风险，operations 只能作用于 ProductDesignState 路径。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PatchAgentInput): PatchPlan {
    const patchType = input.selectedRegion.type === "prototype" ? "prototype" : "document";
    const affectedStatePaths = inferAffectedStatePaths(input.selectedRegion, patchType);
    const sectionId = input.selectedRegion.sectionId;
    const componentId = input.selectedRegion.componentId;
    const pageId = input.selectedRegion.pageId;
    const intent = inferPatchIntent(input.userInput);
    const operationPath = affectedStatePaths[0] ?? (patchType === "prototype" ? "frontendRules" : "businessRules");

    return {
      id: `patch_plan_${Date.now().toString(36)}`,
      projectId: input.productDesignState.projectId,
      intent,
      selectedRegion: input.selectedRegion,
      patchType,
      targetNodes: [
        componentId ||
          sectionId ||
          input.selectedRegion.targetId ||
          "productDesignState",
      ],
      impactScope:
        patchType === "prototype"
          ? ["frontendRules", "stateRules", "acceptanceCriteria", "prototypeSpec"]
          : ["businessRules", "acceptanceCriteria", "prdDocument"],
      operations: [
        {
          op: "add",
          path: operationPath,
          value: {
            id: `patch_${Date.now().toString(36)}`,
            title: input.selectedRegion.label || "局部修改",
            description: input.userInput,
            source: {
              type: "user_confirmed",
              confidence: 0.95,
              note: "来自用户局部修改指令",
            },
            relatedRegion: {
              type: input.selectedRegion.type,
              targetId: input.selectedRegion.targetId,
              pageId,
              componentId,
              sectionId,
            },
          },
          reason: "根据用户局部修改要求写入 ProductDesignState。",
        },
      ],
      impactAnalysis: {
        affectedStatePaths,
        affectedPrdSectionIds: sectionId ? [sectionId] : [],
        affectedPrototypePageIds: pageId ? [pageId] : [],
        affectedPrototypeComponentIds: componentId ? [componentId] : [],
        affectedAcceptanceCriteriaIds: [],
        requiresPrdRegeneration: true,
        requiresPrototypeRegeneration: true,
        requiresQaCheck: true,
        reason: "局部修改通过 ProductDesignState 更新后，需要重新渲染 PRD、PrototypeSpec 和 HTML 原型。",
      },
      regenerationPlan: {
        prd: "full",
        prototypeSpec: "full",
        htmlPrototype: "full",
        qa: "basic",
      },
      risks: [{
        level: "low",
        message: "一期 Patch 会整体重新生成 PRD 与 HTML 原型，确保状态一致。",
        relatedPaths: affectedStatePaths,
      }],
      needUserConfirm: false,
      needsUserConfirmation: false,
      reason: "一期 Patch 先生成可追踪修改计划，后续由 ProductDesignStateService 统一应用版本。",
      summary: `根据局部修改指令更新 ${affectedStatePaths.join("、") || "ProductDesignState"}。`,
    };
  }

  protected normalize(output: PatchPlan, input: PatchAgentInput): PatchPlan {
    const fallback = this.fallback(input);
    const operations = Array.isArray(output.operations) && output.operations.length
      ? output.operations.map((operation) => ({
          op: normalizeOperation(operation.op),
          path: typeof operation.path === "string" ? operation.path : fallback.operations[0].path,
          value: operation.value,
          reason: typeof operation.reason === "string" ? operation.reason : "根据用户局部修改生成。",
        }))
      : fallback.operations;
    const impactAnalysis = normalizeImpactAnalysis(output.impactAnalysis, fallback, operations);

    return {
      id: typeof output.id === "string" && output.id ? output.id : fallback.id,
      projectId: input.productDesignState.projectId,
      intent: normalizeIntent(output.intent) ?? fallback.intent,
      selectedRegion: input.selectedRegion,
      patchType: normalizePatchType(output.patchType) ?? fallback.patchType,
      targetNodes: Array.isArray(output.targetNodes) ? output.targetNodes.map(String) : fallback.targetNodes,
      impactScope: Array.isArray(output.impactScope) ? output.impactScope.map(String) : fallback.impactScope,
      operations,
      impactAnalysis,
      regenerationPlan: normalizeRegenerationPlan(output.regenerationPlan) ?? fallback.regenerationPlan,
      risks: Array.isArray(output.risks)
        ? output.risks.map((risk) => ({
            level: risk.level === "high" || risk.level === "medium" || risk.level === "low" ? risk.level : "low",
            message: typeof risk.message === "string" ? risk.message : "Patch 风险待确认。",
            relatedPaths: Array.isArray(risk.relatedPaths) ? risk.relatedPaths.map(String) : undefined,
          }))
        : fallback.risks,
      needUserConfirm: Boolean(output.needUserConfirm || output.needsUserConfirmation),
      needsUserConfirmation: Boolean(output.needUserConfirm || output.needsUserConfirmation),
      clarificationQuestions: Array.isArray(output.clarificationQuestions)
        ? output.clarificationQuestions
        : undefined,
      reason: typeof output.reason === "string" ? output.reason : fallback.reason,
      summary: typeof output.summary === "string" ? output.summary : fallback.summary,
    };
  }
}

function normalizePatchType(value: unknown): PatchPlan["patchType"] | undefined {
  if (value === "document" || value === "prototype" || value === "state" || value === "global") {
    return value;
  }
  return undefined;
}

function normalizeOperation(value: unknown): PatchPlan["operations"][number]["op"] {
  if (value === "update" || value === "replace") return "update";
  if (value === "delete" || value === "remove") return "delete";
  if (value === "append") return "append";
  return "add";
}

function inferAffectedStatePaths(region: SelectedRegion, patchType: PatchPlan["patchType"]) {
  if (Array.isArray(region.sourcePaths) && region.sourcePaths.length) return region.sourcePaths;
  if (patchType === "prototype") {
    if (region.componentId?.includes("state")) return ["stateRules"];
    if (region.componentId?.includes("action") || region.componentId?.includes("button")) return ["frontendRules"];
    return ["frontendRules"];
  }
  if (region.sectionId?.includes("accept")) return ["acceptanceCriteria"];
  if (region.sectionId?.includes("exception")) return ["exceptionScenarios"];
  if (region.sectionId?.includes("frontend")) return ["frontendRules"];
  return ["businessRules"];
}

function inferPatchIntent(input: string): NonNullable<PatchPlan["intent"]> {
  if (/文案|按钮|标题|改成|命名|叫/i.test(input)) return "copy_change";
  if (/规则|限制|条件|会员|奖励/i.test(input)) return "rule_change";
  if (/状态|置灰|禁用|启用/i.test(input)) return "state_change";
  if (/配置|后台|参数/i.test(input)) return "config_change";
  if (/流程|步骤|跳转/i.test(input)) return "flow_change";
  if (/新增|增加|补充|加一个/i.test(input)) return "add_requirement";
  if (/删除|去掉|不要/i.test(input)) return "remove_requirement";
  return "unknown";
}

function normalizeIntent(value: unknown): PatchPlan["intent"] | undefined {
  const allowed = [
    "copy_change",
    "rule_change",
    "layout_change",
    "state_change",
    "config_change",
    "flow_change",
    "add_requirement",
    "remove_requirement",
    "clarification",
    "unknown",
  ];
  return typeof value === "string" && allowed.includes(value) ? value as PatchPlan["intent"] : undefined;
}

function normalizeImpactAnalysis(
  value: unknown,
  fallback: PatchPlan,
  operations: PatchPlan["operations"],
): NonNullable<PatchPlan["impactAnalysis"]> {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const fallbackImpact = fallback.impactAnalysis!;
  return {
    affectedStatePaths: arrayOfText(record.affectedStatePaths).length
      ? arrayOfText(record.affectedStatePaths)
      : operations.map((operation) => operation.path),
    affectedPrdSectionIds: arrayOfText(record.affectedPrdSectionIds).length
      ? arrayOfText(record.affectedPrdSectionIds)
      : fallbackImpact.affectedPrdSectionIds,
    affectedPrototypePageIds: arrayOfText(record.affectedPrototypePageIds).length
      ? arrayOfText(record.affectedPrototypePageIds)
      : fallbackImpact.affectedPrototypePageIds,
    affectedPrototypeComponentIds: arrayOfText(record.affectedPrototypeComponentIds).length
      ? arrayOfText(record.affectedPrototypeComponentIds)
      : fallbackImpact.affectedPrototypeComponentIds,
    affectedAcceptanceCriteriaIds: arrayOfText(record.affectedAcceptanceCriteriaIds).length
      ? arrayOfText(record.affectedAcceptanceCriteriaIds)
      : fallbackImpact.affectedAcceptanceCriteriaIds,
    requiresPrdRegeneration: typeof record.requiresPrdRegeneration === "boolean"
      ? record.requiresPrdRegeneration
      : true,
    requiresPrototypeRegeneration: typeof record.requiresPrototypeRegeneration === "boolean"
      ? record.requiresPrototypeRegeneration
      : true,
    requiresQaCheck: typeof record.requiresQaCheck === "boolean" ? record.requiresQaCheck : true,
    reason: typeof record.reason === "string" ? record.reason : fallbackImpact.reason,
  };
}

function normalizeRegenerationPlan(value: unknown): PatchPlan["regenerationPlan"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    prd: record.prd === "none" || record.prd === "affected_sections" || record.prd === "full"
      ? record.prd
      : "full",
    prototypeSpec:
      record.prototypeSpec === "none" ||
      record.prototypeSpec === "affected_pages" ||
      record.prototypeSpec === "full"
        ? record.prototypeSpec
        : "full",
    htmlPrototype:
      record.htmlPrototype === "none" ||
      record.htmlPrototype === "affected_pages" ||
      record.htmlPrototype === "full"
        ? record.htmlPrototype
        : "full",
    qa: record.qa === "none" || record.qa === "basic" || record.qa === "full" ? record.qa : "basic",
  };
}

function arrayOfText(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

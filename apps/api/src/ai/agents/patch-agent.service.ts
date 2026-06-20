import { Injectable } from "@nestjs/common";
import { AgentName, ModelTaskType } from "@prisma/client";
import { ModelGatewayService } from "../../model-gateway/model-gateway.service";
import type {
  PatchPlan,
  ProductDesignState,
  PrototypeSpec,
  RequirementDocumentDraft,
  SelectedRegion,
} from "../ai-vibe.types";
import { BaseAgentService } from "./base-agent.service";

type PatchAgentInput = {
  userInput: string;
  selectedRegion: SelectedRegion;
  productDesignState: ProductDesignState;
  prdDocument?: RequirementDocumentDraft;
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
          "你是 Patch Agent。只能输出 PatchPlan JSON，operations 只能作用于 ProductDesignState 路径。",
      },
      { role: "user" as const, content: JSON.stringify(input) },
    ];
  }

  protected fallback(input: PatchAgentInput): PatchPlan {
    const patchType = input.selectedRegion.type === "prototype" ? "prototype" : "document";
    return {
      patchType,
      targetNodes: [
        input.selectedRegion.componentId ||
          input.selectedRegion.sectionId ||
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
          path: patchType === "prototype" ? "frontendRules" : "businessRules",
          value: {
            description: input.userInput,
            source: "user_patch",
          },
          reason: "根据用户局部修改要求追加到 ProductDesignState 规则中。",
        },
      ],
      needUserConfirm: false,
      reason: "一期 Patch 先生成可追踪修改计划，后续由 ProductDesignStateService 统一应用版本。",
    };
  }

  protected normalize(output: PatchPlan, input: PatchAgentInput): PatchPlan {
    const fallback = this.fallback(input);
    return {
      patchType: normalizePatchType(output.patchType) ?? fallback.patchType,
      targetNodes: Array.isArray(output.targetNodes) ? output.targetNodes.map(String) : fallback.targetNodes,
      impactScope: Array.isArray(output.impactScope) ? output.impactScope.map(String) : fallback.impactScope,
      operations: Array.isArray(output.operations) && output.operations.length
        ? output.operations.map((operation) => ({
            op: normalizeOperation(operation.op),
            path: typeof operation.path === "string" ? operation.path : fallback.operations[0].path,
            value: operation.value,
            reason: typeof operation.reason === "string" ? operation.reason : "根据用户局部修改生成。",
          }))
        : fallback.operations,
      needUserConfirm: Boolean(output.needUserConfirm),
      reason: typeof output.reason === "string" ? output.reason : fallback.reason,
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
  return "add";
}

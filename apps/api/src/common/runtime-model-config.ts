import { ModelTaskType } from "@prisma/client";

export type RuntimeModelOption = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

type ModelEnvConfig = {
  name: string;
  label: string;
};

const CAPABILITY_MODEL_ENVS: ModelEnvConfig[] = [
  { name: "DEFAULT_MODEL_FAST_NAME", label: "快速响应" },
  { name: "DEFAULT_MODEL_REASONING_NAME", label: "推理规划" },
  { name: "DEFAULT_MODEL_LONG_CONTEXT_NAME", label: "长上下文" },
  { name: "DEFAULT_MODEL_CODE_NAME", label: "代码生成" },
];

const TASK_LABELS: Record<ModelTaskType, string> = {
  [ModelTaskType.intent_detection]: "意图识别",
  [ModelTaskType.knowledge_classification]: "知识分类",
  [ModelTaskType.requirement_analysis]: "需求分析",
  [ModelTaskType.conversation_planning]: "对话规划",
  [ModelTaskType.conversation_design]: "方案设计",
  [ModelTaskType.prd_generation]: "PRD 生成",
  [ModelTaskType.prototype_design]: "原型设计",
  [ModelTaskType.prototype_code_generation]: "原型代码",
  [ModelTaskType.qa_check]: "质量检查",
  [ModelTaskType.knowledge_extraction]: "知识提取",
  [ModelTaskType.general_chat]: "通用对话",
};

export function buildRuntimeModelOptions() {
  const provider = readEnv("DEERFLOW_MODEL_PROVIDER") ?? readEnv("DEFAULT_MODEL_PROVIDER_NAME") ?? "deerflow";
  const runtimeName = readEnv("DEERFLOW_AGENT_NAME") ?? "lead_agent";
  const defaultModelName =
    readEnv("DEERFLOW_MODEL_NAME") ??
    readEnv("DEFAULT_MODEL_NAME") ??
    "deerflow-runtime";
  const options: RuntimeModelOption[] = [];

  addRuntimeModelOption(options, {
    provider,
    modelName: defaultModelName,
    displayName: readEnv("DEERFLOW_MODEL_DISPLAY_NAME") ?? defaultModelName,
    description: `${runtimeName} · ${defaultModelName}`,
  });

  for (const env of CAPABILITY_MODEL_ENVS) {
    const modelName = readEnv(env.name);
    if (!modelName) continue;

    addRuntimeModelOption(options, {
      provider,
      modelName,
      displayName: `${env.label} · ${modelName}`,
      description: `${runtimeName} · ${env.label}`,
    });
  }

  for (const taskType of Object.values(ModelTaskType)) {
    const modelName = readEnv(taskModelEnvName(taskType));
    if (!modelName) continue;

    const label = TASK_LABELS[taskType] ?? taskType;
    addRuntimeModelOption(options, {
      provider,
      modelName,
      displayName: `${label} · ${modelName}`,
      description: `${runtimeName} · ${label}`,
    });
  }

  return options;
}

export function resolveSelectedRuntimeModelName(selectedModelId?: string) {
  const selectedModelName = modelNameFromModelId(selectedModelId);
  if (!selectedModelName) return undefined;

  const allowedModelNames = new Set(buildRuntimeModelOptions().map((model) => modelNameFromModelId(model.id)));
  return allowedModelNames.has(selectedModelName) ? selectedModelName : undefined;
}

function addRuntimeModelOption(
  options: RuntimeModelOption[],
  input: {
    provider: string;
    modelName: string;
    displayName: string;
    description: string;
  },
) {
  if (options.some((option) => modelNameFromModelId(option.id) === input.modelName)) return;

  options.push({
    id: `${input.provider}/${input.modelName}`,
    name: input.displayName,
    provider: input.provider,
    description: input.description,
  });
}

function modelNameFromModelId(modelId?: string) {
  if (!modelId) return undefined;
  const separatorIndex = modelId.indexOf("/");
  const modelName = separatorIndex >= 0 ? modelId.slice(separatorIndex + 1) : modelId;
  return modelName.trim() || undefined;
}

function taskModelEnvName(taskType: ModelTaskType) {
  return `DEFAULT_MODEL_TASK_${taskType.toUpperCase()}_NAME`;
}

function readEnv(name: string) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

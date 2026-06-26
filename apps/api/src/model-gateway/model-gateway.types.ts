import type { ModelResponseFormat, ModelTaskType } from "@prisma/client";

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ModelGatewayErrorCode =
  | "MODEL_PROVIDER_NOT_FOUND"
  | "MODEL_PROVIDER_DISABLED"
  | "MODEL_CONFIG_NOT_FOUND"
  | "MODEL_CONFIG_DISABLED"
  | "MODEL_TASK_PROFILE_NOT_FOUND"
  | "MODEL_CALL_FAILED"
  | "MODEL_CALL_TIMEOUT"
  | "MODEL_JSON_PARSE_FAILED"
  | "MODEL_STREAM_FAILED"
  | "MODEL_API_KEY_INVALID"
  | "MODEL_PROVIDER_UNAUTHORIZED";

export type GenerateTextInput = {
  taskType: ModelTaskType;
  messages: ModelMessage[];
  runtimeName?: string;
  runId?: string;
  traceId?: string;
  userId?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retryCount?: number;
};

export type GenerateTextResult = {
  content: string;
  modelCallLogId: string;
  usage?: TokenUsage;
};

export type GenerateJsonInput<TSchema = unknown> = GenerateTextInput & {
  jsonSchema?: TSchema;
  jsonParseRetryCount?: number;
};

export type GenerateJsonResult<T = unknown> = {
  data: T;
  rawContent: string;
  modelCallLogId: string;
  usage?: TokenUsage;
};

export type StreamTextInput = GenerateTextInput & {
  onDelta: (delta: string) => Promise<void> | void;
  onComplete?: (content: string, usage?: TokenUsage) => Promise<void> | void;
};

export type ResolvedModelRoute = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  defaultHeaders?: Record<string, string>;
  providerTimeoutMs: number;
  modelConfigId: string;
  modelName: string;
  supportsStreaming: boolean;
  supportsJsonMode: boolean;
  defaultTemperature: number;
  defaultMaxTokens?: number;
  taskType: ModelTaskType;
  responseFormat: ModelResponseFormat;
  retryCount: number;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
};

export type AdapterChatInput = {
  route: ResolvedModelRoute;
  messages: ModelMessage[];
  responseFormat?: ModelResponseFormat;
  stream?: false;
};

export type AdapterChatResult = {
  content: string;
  usage?: TokenUsage;
};

export type AdapterStreamInput = {
  route: ResolvedModelRoute;
  messages: ModelMessage[];
  responseFormat?: ModelResponseFormat;
  onDelta: (delta: string) => Promise<void> | void;
};

export type AdapterStreamResult = {
  content: string;
  usage?: TokenUsage;
};

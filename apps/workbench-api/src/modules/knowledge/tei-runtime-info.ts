import { z } from "zod";
import { KnowledgeProviderError } from "./tei-json.client.js";

const teiRuntimeInfoSchema = z.object({
  model_id: z.string().min(1),
  model_sha: z.string().min(1),
  version: z.string().min(1),
  max_input_length: z.number().int().positive(),
  max_batch_tokens: z.number().int().positive(),
  max_client_batch_size: z.number().int().positive(),
  auto_truncate: z.literal(false),
}).passthrough();

export type TeiRuntimeInfo = z.infer<typeof teiRuntimeInfoSchema>;

export function parseTeiRuntimeInfo(value: unknown): TeiRuntimeInfo {
  const result = teiRuntimeInfoSchema.safeParse(value);
  if (!result.success) {
    throw new KnowledgeProviderError("KNOWLEDGE_PROVIDER_INFO_INVALID", false, { cause: result.error });
  }
  return result.data;
}

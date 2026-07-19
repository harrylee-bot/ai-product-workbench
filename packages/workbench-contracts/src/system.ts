import { z } from "zod";
import { opaqueIdSchema } from "./common.js";

export const healthSchema = z.object({
  status: z.string(),
}).strict();

export const principalSchema = z.object({
  id: opaqueIdSchema,
  issuer: z.string(),
  subject: z.string(),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  defaultWorkspaceId: opaqueIdSchema,
}).strict();

export const httpEntityTagSchema = z.string()
  .min(3)
  .max(130)
  .regex(/^"[\x21\x23-\x7e]{1,128}"$/);

export type Health = z.infer<typeof healthSchema>;
export type Principal = z.infer<typeof principalSchema>;

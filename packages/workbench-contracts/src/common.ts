import { z } from "zod";

export const opaqueIdSchema = z.string().min(1).max(128);
export const runEventSourceIdMaxLength = 128;
export const runEventSourceIdPattern = /^[A-Za-z0-9._:-]+$/u;
export const runEventSourceIdSchema = z.string()
  .min(1)
  .max(runEventSourceIdMaxLength)
  .regex(runEventSourceIdPattern);
export const isoDateTimeSchema = z.string().datetime();
export const revisionSchema = z.number().int().nonnegative();

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const problemDetailsSchema = z.object({
  type: z.string().default("about:blank"),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().min(1),
  requestId: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

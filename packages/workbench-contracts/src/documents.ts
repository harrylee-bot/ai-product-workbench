import { z } from "zod";

export const businessDocumentSchema = z.object({
  protocol: z.literal("workbench.document.v1").optional(),
  title: z.string().min(1).max(240).optional(),
  text: z.string().min(1).max(1_000_000).optional(),
  markdown: z.string().min(1).max(1_000_000).optional(),
}).strict().refine((document) => Boolean(document.text?.trim()) !== Boolean(document.markdown?.trim()), {
  message: "A business document requires exactly one nonempty text or markdown body",
});

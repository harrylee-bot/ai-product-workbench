import { z } from "zod";

const identity = z.string().min(1).max(160);
const coordinate = z.number().finite().min(-32768).max(32768);
const size = z.number().finite().nonnegative().max(32768);
export const prototypeGeometryNodeSchema = z.object({
  nodeId: identity, selector: z.string().min(1).max(500),
  label: z.string().max(160), tag: z.string().max(40), parentSelector: z.string().max(500).nullable(),
  x: coordinate, y: coordinate, width: size, height: size,
}).strict();
export const prototypeGeometryMessageSchema = z.object({
  protocol: z.literal("workbench.studio.frame.v1"),
  sessionId: identity, revisionId: identity, pageId: identity,
  sequence: z.number().int().positive(),
  kind: z.enum(["page", "ready", "selection", "hover", "measure", "layers", "missing", "exit"]),
  viewport: z.object({ width: size, height: size, scrollX: coordinate, scrollY: coordinate }).strict(),
  node: prototypeGeometryNodeSchema.nullable(),
  layers: z.array(prototypeGeometryNodeSchema).max(120),
}).strict();
export type PrototypeGeometryNode = z.infer<typeof prototypeGeometryNodeSchema>;
export type PrototypeGeometryMessage = z.infer<typeof prototypeGeometryMessageSchema>;

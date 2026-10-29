import { z } from "zod";

const color = z.string().regex(/^(?:#[a-fA-F0-9]{3,8}|transparent|white|black)$/).nullable();
const dimension = z.number().finite().min(0).max(16_384);

// A bounded, inert projection of unfinished authoring data. It is never an Artifact.
export const generationPreviewNodeSchema = z.object({
  id: z.string().min(1).max(160),
  parentId: z.string().max(160).nullable(),
  kind: z.enum(["frame", "form", "text", "button", "input", "image", "shape", "icon"]),
  text: z.string().max(2_000),
  x: z.number().finite().min(-16_384).max(16_384),
  y: z.number().finite().min(-16_384).max(16_384),
  width: dimension.nullable(),
  height: dimension.nullable(),
  absolute: z.boolean(),
  direction: z.enum(["row", "column"]),
  gap: dimension,
  padding: dimension,
  fill: color,
  color,
  fontSize: z.number().finite().min(1).max(120).nullable(),
  radius: dimension,
}).strict();

export const generationPreviewSchema = z.object({
  artifactIndex: z.number().int().min(0).max(19),
  kind: z.enum(["prd", "prototype"]),
  title: z.string().min(1).max(240),
  markdown: z.string().max(48_000),
  screens: z.array(z.object({
    id: z.string().min(1).max(160),
    name: z.string().max(240),
    width: dimension.positive(),
    height: dimension.positive(),
    nodes: z.array(generationPreviewNodeSchema).max(120),
  }).strict()).max(4),
}).strict();

export type GenerationPreview = z.infer<typeof generationPreviewSchema>;
export type GenerationPreviewNode = z.infer<typeof generationPreviewNodeSchema>;

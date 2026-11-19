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

export const MAX_PROTOTYPE_DRAFT_PREVIEW_BYTES = 24_000;

export function generationPreviewText(value: unknown, limit = 2_000): string {
  return typeof value === "string"
    ? value.replace(/wb(?:kg|ct)1\.[A-Za-z0-9_.-]*/gu, "[已隐藏]").slice(0, limit)
    : "";
}

type PreviewRecord = Record<string, unknown>;
const record = (value: unknown): PreviewRecord => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as PreviewRecord : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const numeric = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value)
  ? Math.max(-16_384, Math.min(16_384, value)) : fallback;
const literal = (value: unknown) => record(value).value ?? value;
const previewColor = (value: unknown) => {
  const candidate = generationPreviewText(literal(value));
  return color.safeParse(candidate).success ? candidate : null;
};

export function projectPrototypeGenerationPreview(artifactIndex: number, value: unknown): GenerationPreview | null {
  const draft = record(value);
  if (draft.kind !== "prototype") return null;
  const content = record(draft.content);
  const title = generationPreviewText(draft.title ?? content.title, 240);
  const nodes = array(content.nodes);
  const screens = array(content.screens).slice(0, 4).flatMap((value) => {
    const screen = record(value);
    const id = generationPreviewText(screen.id, 160);
    if (!id) return [];
    return [{
      id, name: generationPreviewText(screen.name, 240),
      width: Math.max(1, numeric(record(screen.viewport).width, 390)),
      height: Math.max(1, numeric(record(screen.viewport).height, 844)),
      nodes: nodes.filter((node) => record(node).screenId === screen.id && record(node).visible !== false)
        .slice(0, 120).flatMap(projectNode),
    }];
  });
  const parsed = generationPreviewSchema.safeParse({ artifactIndex, kind: "prototype", title, markdown: "", screens });
  return parsed.success ? parsed.data : null;
}

function projectNode(value: unknown): GenerationPreviewNode[] {
  const node = record(value);
  const layout = record(node.layout);
  const style = record(node.style);
  const typography = record(style.typography);
  const id = generationPreviewText(node.id, 160);
  const kind = node.kind;
  if (!id || !["frame", "form", "text", "button", "input", "image", "shape", "icon"].includes(String(kind))) return [];
  return [{
    id, parentId: generationPreviewText(node.parentId, 160) || null, kind: kind as GenerationPreviewNode["kind"],
    text: generationPreviewText(node.text ?? node.label ?? node.placeholder ?? node.name),
    x: numeric(literal(layout.x)), y: numeric(literal(layout.y)),
    width: layout.width == null ? null : Math.max(0, numeric(literal(layout.width))),
    height: layout.height == null ? null : Math.max(0, numeric(literal(layout.height))),
    absolute: layout.mode === "absolute", direction: layout.direction === "row" ? "row" : "column",
    gap: Math.max(0, numeric(literal(layout.gap))),
    padding: Math.max(0, numeric(literal(record(layout.padding).top))),
    fill: previewColor(style.fill), color: previewColor(typography.color),
    fontSize: typography.fontSize == null ? null : Math.max(1, Math.min(120, numeric(literal(typography.fontSize), 14))),
    radius: Math.max(0, numeric(literal(record(style.radii).topLeft))),
  }];
}

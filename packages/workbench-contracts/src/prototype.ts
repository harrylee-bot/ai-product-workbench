import { z } from "zod";
import { artifactIrIdSchema } from "./citations.js";

const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const positiveNumberSchema = finiteNumberSchema.positive();
const colorSchema = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i);

export const prototypeTokenReferenceSchema = z.object({
  kind: z.literal("token"),
  tokenId: artifactIrIdSchema,
}).strict();

export const prototypeNumberValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: finiteNumberSchema }).strict(),
  prototypeTokenReferenceSchema,
]);

export const prototypeNonNegativeValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: nonNegativeNumberSchema }).strict(),
  prototypeTokenReferenceSchema,
]);

export const prototypePositiveValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: positiveNumberSchema }).strict(),
  prototypeTokenReferenceSchema,
]);

export const prototypeColorValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: colorSchema }).strict(),
  prototypeTokenReferenceSchema,
]);

export const prototypeStringValueSchema = z.union([
  z.object({ kind: z.literal("literal"), value: z.string().min(1).max(500) }).strict(),
  prototypeTokenReferenceSchema,
]);

export const prototypeColorTokenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(160),
  type: z.literal("color"),
  value: colorSchema,
}).strict();

export const prototypeNumericTokenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(160),
  type: z.enum(["number", "spacing", "radius", "fontSize", "lineHeight", "borderWidth", "duration"]),
  value: nonNegativeNumberSchema,
}).strict();

export const prototypeFontFamilyTokenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(160),
  type: z.literal("fontFamily"),
  value: z.string().min(1).max(240),
}).strict();

export const prototypeFontWeightTokenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(160),
  type: z.literal("fontWeight"),
  value: z.union([
    z.literal(100), z.literal(200), z.literal(300), z.literal(400), z.literal(500),
    z.literal(600), z.literal(700), z.literal(800), z.literal(900),
  ]),
}).strict();

export const prototypeShadowTokenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(160),
  type: z.literal("shadow"),
  value: z.object({
    color: colorSchema,
    offsetX: finiteNumberSchema,
    offsetY: finiteNumberSchema,
    blur: nonNegativeNumberSchema,
    spread: finiteNumberSchema,
  }).strict(),
}).strict();

export const prototypeTokenSchema = z.union([
  prototypeColorTokenSchema,
  prototypeNumericTokenSchema,
  prototypeFontFamilyTokenSchema,
  prototypeFontWeightTokenSchema,
  prototypeShadowTokenSchema,
]);

export const prototypePaddingSchema = z.object({
  top: prototypeNonNegativeValueSchema,
  right: prototypeNonNegativeValueSchema,
  bottom: prototypeNonNegativeValueSchema,
  left: prototypeNonNegativeValueSchema,
}).strict();

export const prototypeLayoutSchema = z.object({
  mode: z.enum(["absolute", "flow"]),
  x: prototypeNumberValueSchema,
  y: prototypeNumberValueSchema,
  width: prototypePositiveValueSchema,
  height: prototypePositiveValueSchema,
  display: z.enum(["block", "flex", "grid"]),
  direction: z.enum(["row", "column"]),
  gap: prototypeNonNegativeValueSchema,
  padding: prototypePaddingSchema,
  align: z.enum(["start", "center", "end", "stretch"]),
  justify: z.enum(["start", "center", "end", "spaceBetween", "spaceAround"]),
  gridColumns: z.number().int().min(1).max(24).nullable(),
  overflow: z.enum(["visible", "hidden", "scroll", "auto"]),
}).strict();

export const prototypeStrokeSchema = z.object({
  color: prototypeColorValueSchema,
  width: prototypeNonNegativeValueSchema,
  style: z.enum(["solid", "dashed", "dotted"]),
  position: z.enum(["inside", "center", "outside"]),
}).strict();

export const prototypeRadiiSchema = z.object({
  topLeft: prototypeNonNegativeValueSchema,
  topRight: prototypeNonNegativeValueSchema,
  bottomRight: prototypeNonNegativeValueSchema,
  bottomLeft: prototypeNonNegativeValueSchema,
}).strict();

export const prototypeTypographySchema = z.object({
  fontFamily: prototypeStringValueSchema,
  fontSize: prototypePositiveValueSchema,
  fontWeight: z.union([
    z.object({
      kind: z.literal("literal"),
      value: z.union([
        z.literal(100), z.literal(200), z.literal(300), z.literal(400), z.literal(500),
        z.literal(600), z.literal(700), z.literal(800), z.literal(900),
      ]),
    }).strict(),
    prototypeTokenReferenceSchema,
  ]),
  lineHeight: prototypePositiveValueSchema,
  letterSpacing: prototypeNumberValueSchema,
  align: z.enum(["left", "center", "right", "justify"]),
  transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]),
  decoration: z.enum(["none", "underline", "lineThrough"]),
}).strict();

export const prototypeRotationSchema = finiteNumberSchema
  .min(-180)
  .lt(180)
  .describe("Clockwise node rotation in degrees, normalized to the half-open interval [-180, 180)");

export const prototypeTransformOriginSchema = z.object({
  x: finiteNumberSchema.min(0).max(1),
  y: finiteNumberSchema.min(0).max(1),
}).strict().describe("Rotation origin as normalized fractions of the node border box: (0,0) is top-left and (1,1) is bottom-right");

export const prototypeStyleSchema = z.object({
  opacity: z.number().min(0).max(1),
  rotation: prototypeRotationSchema,
  transformOrigin: prototypeTransformOriginSchema,
  fill: prototypeColorValueSchema.nullable(),
  stroke: prototypeStrokeSchema.nullable(),
  radii: prototypeRadiiSchema,
  shadowTokenIds: z.array(artifactIrIdSchema).max(8),
  typography: prototypeTypographySchema.nullable(),
}).strict();

export const prototypeImageAssetSchema = z.object({
  id: artifactIrIdSchema,
  kind: z.literal("image"),
  name: z.string().min(1).max(240),
  blobId: artifactIrIdSchema,
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const prototypeIconAssetSchema = z.object({
  id: artifactIrIdSchema,
  kind: z.literal("icon"),
  name: z.string().min(1).max(240),
  library: z.enum(["lucide"]),
  iconName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,119}$/),
}).strict();

export const prototypeFontAssetSchema = z.object({
  id: artifactIrIdSchema,
  kind: z.literal("font"),
  name: z.string().min(1).max(240),
  blobId: artifactIrIdSchema,
  mediaType: z.enum(["font/woff", "font/woff2"]),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  family: z.string().min(1).max(240),
  weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]),
}).strict();

export const prototypeAssetSchema = z.discriminatedUnion("kind", [
  prototypeImageAssetSchema,
  prototypeIconAssetSchema,
  prototypeFontAssetSchema,
]);

export const publicPrototypeImageAssetSchema = prototypeImageAssetSchema.omit({ blobId: true });
export const publicPrototypeFontAssetSchema = prototypeFontAssetSchema.omit({ blobId: true });
export const publicPrototypeAssetSchema = z.discriminatedUnion("kind", [
  publicPrototypeImageAssetSchema,
  prototypeIconAssetSchema,
  publicPrototypeFontAssetSchema,
]);

const nodeBaseShape = {
  id: artifactIrIdSchema,
  screenId: artifactIrIdSchema,
  parentId: artifactIrIdSchema.nullable(),
  name: z.string().min(1).max(240),
  visible: z.boolean(),
  layout: prototypeLayoutSchema,
  style: prototypeStyleSchema,
  actionIds: z.array(artifactIrIdSchema).max(50),
  bindingIds: z.array(artifactIrIdSchema).max(50),
  motionIds: z.array(artifactIrIdSchema).max(50),
};

export const prototypeFrameNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("frame"),
  childIds: z.array(artifactIrIdSchema).max(2_000),
  clipContent: z.boolean(),
}).strict();

export const prototypeFormNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("form"),
  childIds: z.array(artifactIrIdSchema).max(2_000),
}).strict();

export const prototypeTextNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("text"),
  text: z.string().max(100_000),
  maxLines: z.number().int().positive().nullable(),
}).strict();

export const prototypeIconNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("icon"),
  assetId: artifactIrIdSchema,
  accessibilityLabel: z.string().min(1).max(500).nullable(),
}).strict();

export const prototypeImageNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("image"),
  assetId: artifactIrIdSchema,
  fit: z.enum(["contain", "cover", "fill", "none"]),
  alt: z.string().max(1_000),
}).strict();

export const prototypeVectorCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("moveTo"), x: finiteNumberSchema, y: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("lineTo"), x: finiteNumberSchema, y: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("horizontalTo"), x: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("verticalTo"), y: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("curveTo"), control1X: finiteNumberSchema, control1Y: finiteNumberSchema, control2X: finiteNumberSchema, control2Y: finiteNumberSchema, x: finiteNumberSchema, y: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("quadraticTo"), controlX: finiteNumberSchema, controlY: finiteNumberSchema, x: finiteNumberSchema, y: finiteNumberSchema }).strict(),
  z.object({ command: z.literal("close") }).strict(),
]);

export const prototypeVectorPathSchema = z.object({
  id: artifactIrIdSchema,
  commands: z.array(prototypeVectorCommandSchema).min(1).max(5_000),
  fillRule: z.enum(["nonzero", "evenodd"]),
}).strict();

export const prototypeVectorNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("vector"),
  viewBox: z.object({
    minX: finiteNumberSchema,
    minY: finiteNumberSchema,
    width: positiveNumberSchema,
    height: positiveNumberSchema,
  }).strict(),
  paths: z.array(prototypeVectorPathSchema).min(1).max(500),
}).strict();

export const prototypeButtonNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("button"),
  label: z.string().min(1).max(500),
  childIds: z.array(artifactIrIdSchema).max(100),
  buttonType: z.enum(["button", "submit", "reset"]),
  disabled: z.boolean(),
}).strict();

export const prototypeSelectOptionSchema = z.object({
  value: z.string().min(1).max(10_000),
  label: z.string().min(1).max(500),
  disabled: z.boolean(),
}).strict();

const canonicalPrototypeDateInputPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCanonicalPrototypeDateInputValue(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string") return false;
  const match = canonicalPrototypeDateInputPattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

export const prototypeInputNodeSchema = z.object({
  ...nodeBaseShape,
  kind: z.literal("input"),
  inputType: z.enum(["text", "email", "password", "number", "search", "date", "textarea", "select", "checkbox", "radio"])
    .describe("date inputs bind an empty string or a canonical YYYY-MM-DD calendar date; locale dates, timestamps, and timezone suffixes are invalid"),
  fieldName: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/),
  label: z.string().min(1).max(500),
  placeholder: z.string().max(1_000),
  optionValue: z.string().min(1).max(10_000).nullable(),
  options: z.array(prototypeSelectOptionSchema).max(500),
  required: z.boolean(),
  disabled: z.boolean(),
}).strict();

export const prototypeNodeSchema = z.discriminatedUnion("kind", [
  prototypeFrameNodeSchema,
  prototypeFormNodeSchema,
  prototypeTextNodeSchema,
  prototypeIconNodeSchema,
  prototypeImageNodeSchema,
  prototypeVectorNodeSchema,
  prototypeButtonNodeSchema,
  prototypeInputNodeSchema,
]);

export const prototypeScreenSchema = z.object({
  id: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  route: z.string().min(1).max(1_024).regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/),
  rootNodeId: artifactIrIdSchema,
  initialStateId: artifactIrIdSchema.nullable(),
  viewport: z.object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }).strict(),
}).strict();

export const prototypeStateOverrideSchema = z.object({
  nodeId: artifactIrIdSchema,
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  text: z.string().max(100_000).optional(),
  assetId: artifactIrIdSchema.optional(),
  style: prototypeStyleSchema.optional(),
}).strict().refine((override) => Object.keys(override).some((key) => key !== "nodeId"), "state override must change at least one property");

export const prototypeRuntimeValueSchema = z.union([
  z.string().max(10_000),
  finiteNumberSchema,
  z.boolean(),
  z.null(),
]);

const prototypeRuntimeFieldNameSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,119}$/);

const prototypeRuntimePathSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/)
  .max(500);

export type PrototypeExpression =
  | { kind: "literal"; value: PrototypeRuntimeValue }
  | { kind: "variable"; path: string }
  | { kind: "contains" | "equals"; left: PrototypeExpression; right: PrototypeExpression }
  | { kind: "and" | "or"; operands: PrototypeExpression[] }
  | { kind: "not"; operand: PrototypeExpression };

export const PROTOTYPE_EXPRESSION_MAX_DEPTH = 8;
export const PROTOTYPE_EXPRESSION_MAX_NODES = 64;
export const PROTOTYPE_EXPRESSION_MAX_OPERANDS = 16;

function prototypeExpressionLevelSchema(child?: z.ZodType<PrototypeExpression>): z.ZodType<PrototypeExpression> {
  const literal = z.object({ kind: z.literal("literal"), value: prototypeRuntimeValueSchema }).strict();
  const variable = z.object({ kind: z.literal("variable"), path: prototypeRuntimePathSchema }).strict();
  if (!child) return z.discriminatedUnion("kind", [literal, variable]);
  return z.discriminatedUnion("kind", [
    literal,
    variable,
    z.object({ kind: z.literal("contains"), left: child, right: child }).strict(),
    z.object({ kind: z.literal("equals"), left: child, right: child }).strict(),
    z.object({ kind: z.literal("and"), operands: z.array(child).min(1).max(PROTOTYPE_EXPRESSION_MAX_OPERANDS) }).strict(),
    z.object({ kind: z.literal("or"), operands: z.array(child).min(1).max(PROTOTYPE_EXPRESSION_MAX_OPERANDS) }).strict(),
    z.object({ kind: z.literal("not"), operand: child }).strict(),
  ]);
}

// Named, acyclic levels let OpenAPI reuse references instead of expanding a
// recursive or exponentially duplicated schema. The root counts as depth one.
export const prototypeExpressionDepth1Schema = prototypeExpressionLevelSchema();
export const prototypeExpressionDepth2Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth1Schema);
export const prototypeExpressionDepth3Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth2Schema);
export const prototypeExpressionDepth4Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth3Schema);
export const prototypeExpressionDepth5Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth4Schema);
export const prototypeExpressionDepth6Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth5Schema);
export const prototypeExpressionDepth7Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth6Schema);
export const prototypeExpressionDepth8Schema = prototypeExpressionLevelSchema(prototypeExpressionDepth7Schema);

export const prototypeExpressionSchema = z.preprocess((input, context) => {
  try {
    // Bound the walk before Zod parses a potentially broad expression tree.
    prototypeExpressionVariablePaths(input as PrototypeExpression);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expression must use supported nodes with depth <= 8, at most 64 nodes and 1-16 operands per and/or",
      fatal: true,
    });
    return z.NEVER;
  }
  return input;
// The guard never transforms accepted input. Preserve that input type for the
// explicitly typed Artifact/Run envelope schemas that contain this expression.
}, prototypeExpressionDepth8Schema) as z.ZodEffects<z.ZodType<PrototypeExpression>, PrototypeExpression, PrototypeExpression>;

/** Self-contained so the same bounded evaluator can be embedded in exports. */
export function evaluatePrototypeExpression(
  expression: PrototypeExpression,
  resolveVariable: (path: string) => PrototypeRuntimeValue | undefined,
): PrototypeRuntimeValue {
  let count = 0;
  const scalar = (value: unknown): value is PrototypeRuntimeValue => (
    value === null || typeof value === "boolean"
    || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
  );
  const visit = (node: PrototypeExpression, depth: number): PrototypeRuntimeValue => {
    count += 1;
    // Keep these limits local: Function#toString consumers must need no globals.
    if (depth > 8 || count > 64) throw new Error("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
    if (!node || typeof node !== "object") throw new Error("PROTOTYPE_EXPRESSION_INVALID");
    if (node.kind === "literal") {
      if (!scalar(node.value)) throw new Error("PROTOTYPE_EXPRESSION_TYPE_INVALID");
      return node.value;
    }
    if (node.kind === "variable") {
      if (typeof node.path !== "string") throw new Error("PROTOTYPE_EXPRESSION_INVALID");
      const value = resolveVariable(node.path);
      if (value === undefined) throw new Error("PROTOTYPE_EXPRESSION_VARIABLE_UNRESOLVED");
      if (!scalar(value)) throw new Error("PROTOTYPE_EXPRESSION_TYPE_INVALID");
      return value;
    }
    if (node.kind === "contains" || node.kind === "equals") {
      const left = visit(node.left, depth + 1);
      const right = visit(node.right, depth + 1);
      if (node.kind === "contains") {
        if (typeof left !== "string" || typeof right !== "string") throw new Error("PROTOTYPE_EXPRESSION_TYPE_INVALID");
        return left.toLowerCase().includes(right.trim().toLowerCase());
      }
      return left === right;
    }
    if (node.kind === "not") {
      const value = visit(node.operand, depth + 1);
      if (typeof value !== "boolean") throw new Error("PROTOTYPE_EXPRESSION_TYPE_INVALID");
      return !value;
    }
    if (node.kind === "and" || node.kind === "or") {
      if (!Array.isArray(node.operands) || node.operands.length < 1 || node.operands.length > 16) {
        throw new Error("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
      }
      // Visit every operand so short-circuiting cannot hide bad types or paths.
      const values = node.operands.map((operand) => visit(operand, depth + 1));
      if (values.some((value) => typeof value !== "boolean")) throw new Error("PROTOTYPE_EXPRESSION_TYPE_INVALID");
      return node.kind === "and" ? values.every((value) => value === true) : values.some((value) => value === true);
    }
    throw new Error("PROTOTYPE_EXPRESSION_INVALID");
  };
  return visit(expression, 1);
}

/** Return every dependency, including operands that currently short-circuit. */
export function prototypeExpressionVariablePaths(expression: PrototypeExpression): string[] {
  const paths = new Set<string>();
  let count = 0;
  const visit = (node: PrototypeExpression, depth: number): void => {
    count += 1;
    if (depth > 8 || count > 64) throw new Error("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
    if (!node || typeof node !== "object") throw new Error("PROTOTYPE_EXPRESSION_INVALID");
    if (node.kind === "literal") return;
    if (node.kind === "variable") {
      if (typeof node.path !== "string") throw new Error("PROTOTYPE_EXPRESSION_INVALID");
      paths.add(node.path);
      return;
    }
    if (node.kind === "contains" || node.kind === "equals") {
      visit(node.left, depth + 1);
      visit(node.right, depth + 1);
      return;
    }
    if (node.kind === "not") {
      visit(node.operand, depth + 1);
      return;
    }
    if (node.kind === "and" || node.kind === "or") {
      if (!Array.isArray(node.operands) || node.operands.length < 1 || node.operands.length > 16) {
        throw new Error("PROTOTYPE_EXPRESSION_LIMIT_EXCEEDED");
      }
      node.operands.forEach((operand) => visit(operand, depth + 1));
      return;
    }
    throw new Error("PROTOTYPE_EXPRESSION_INVALID");
  };
  visit(expression, 1);
  return [...paths].sort();
}

export const prototypeVariableSchema = z.object({
  path: prototypeRuntimePathSchema,
  initialValue: prototypeRuntimeValueSchema,
}).strict();

export const prototypeStateSchema = z.object({
  id: artifactIrIdSchema,
  screenId: artifactIrIdSchema,
  name: z.string().min(1).max(240),
  values: z.record(prototypeRuntimeFieldNameSchema, prototypeRuntimeValueSchema)
    .refine((values) => Object.keys(values).length <= 200, "state may define at most 200 values"),
  overrides: z.array(prototypeStateOverrideSchema).min(1).max(2_000),
}).strict();

const actionBaseShape = {
  id: artifactIrIdSchema,
  nodeId: artifactIrIdSchema,
  event: z.enum(["click", "press", "change", "submit", "focus", "blur"]),
};

export const prototypeNavigateActionSchema = z.object({
  ...actionBaseShape,
  kind: z.literal("navigate"),
  targetScreenId: artifactIrIdSchema,
}).strict();

export const prototypeSetStateActionSchema = z.object({
  ...actionBaseShape,
  kind: z.literal("setState"),
  targetStateId: artifactIrIdSchema,
}).strict();

const prototypeOpenUrlPrefix = /^(?:https?:\/\/|mailto:|tel:)/i;

export function isSafePrototypeOpenUrl(value: string): boolean {
  const mailtoQueryKeys = new Set(["subject", "body", "cc", "bcc"]);
  const emailAddress = /^[^@\s,?#]+@[^@\s,?#]+$/;
  const httpPrefix = /^https?:\/\//i;
  const telUrl = /^tel:\+?[0-9](?:[0-9(). -]{0,63}[0-9])?(?:;ext=[0-9]{1,10})?$/i;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 2_048
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") {
    return httpPrefix.test(value) && parsed.hostname.length > 0;
  }
  if (protocol === "tel:") return telUrl.test(value);
  if (protocol !== "mailto:" || !/^mailto:/i.test(value)) return false;
  if (/%0[ad]/i.test(value)) return false;

  const recipients = parsed.pathname.split(",");
  if (
    recipients.length === 0
    || recipients.some((recipient) => !emailAddress.test(recipient))
  ) {
    return false;
  }
  for (const [key, queryValue] of parsed.searchParams) {
    if (!mailtoQueryKeys.has(key.toLowerCase()) || /[\r\n]/.test(queryValue)) return false;
    if (
      (key.toLowerCase() === "cc" || key.toLowerCase() === "bcc")
      && queryValue.split(",").some((address) => !emailAddress.test(address))
    ) {
      return false;
    }
  }
  return parsed.hash.length === 0;
}

export const prototypeOpenUrlSchema = z.string().url().max(2_048)
  .regex(prototypeOpenUrlPrefix, "only HTTP(S), mailto, and tel URLs are allowed")
  .refine(isSafePrototypeOpenUrl, "URL is not safe for Prototype navigation");

export const prototypeOpenUrlActionSchema = z.object({
  ...actionBaseShape,
  kind: z.literal("openUrl"),
  url: prototypeOpenUrlSchema,
  target: z.enum(["sameWindow", "newWindow"]),
}).strict();

export const prototypeSubmitActionSchema = z.object({
  ...actionBaseShape,
  kind: z.literal("submit"),
  bindingIds: z.array(artifactIrIdSchema).min(1).max(200),
  successStateId: artifactIrIdSchema.nullable(),
}).strict();

export const prototypeSubmitValueSchema = z.object({
  bindingId: artifactIrIdSchema,
  nodeId: artifactIrIdSchema,
  fieldName: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/),
  value: prototypeRuntimeValueSchema,
}).strict();

export const prototypeSubmitDetailSchema = z.object({
  protocol: z.literal("workbench.prototype-submit.v1"),
  kind: z.literal("submit"),
  documentId: artifactIrIdSchema,
  actionId: artifactIrIdSchema,
  formNodeId: artifactIrIdSchema,
  screenId: artifactIrIdSchema,
  values: z.array(prototypeSubmitValueSchema).min(1).max(200),
}).strict();

export const prototypeActionSchema = z.discriminatedUnion("kind", [
  prototypeNavigateActionSchema,
  prototypeSetStateActionSchema,
  prototypeOpenUrlActionSchema,
  prototypeSubmitActionSchema,
]);

export const prototypeBindingSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("variable"),
    path: prototypeRuntimePathSchema,
  }).strict(),
  z.object({
    kind: z.literal("state"),
    stateId: artifactIrIdSchema,
    field: prototypeRuntimeFieldNameSchema,
  }).strict(),
  z.object({
    kind: z.literal("literal"),
    value: prototypeRuntimeValueSchema,
  }).strict(),
  z.object({
    kind: z.literal("expression"),
    expression: prototypeExpressionSchema,
  }).strict(),
]);

export const prototypeBindingSchema = z.object({
  id: artifactIrIdSchema,
  nodeId: artifactIrIdSchema,
  property: z.enum(["text", "value", "visible", "enabled", "imageAssetId"]),
  source: prototypeBindingSourceSchema,
}).strict();

export const prototypeMotionSchema = z.object({
  id: artifactIrIdSchema,
  nodeId: artifactIrIdSchema,
  trigger: z.enum(["enter", "exit", "hover", "press", "stateChange", "action"]),
  stateId: artifactIrIdSchema.nullable(),
  actionId: artifactIrIdSchema.nullable(),
  property: z.enum(["opacity", "x", "y", "scale", "rotation"]),
  from: finiteNumberSchema,
  to: finiteNumberSchema,
  duration: prototypeNonNegativeValueSchema,
  delay: prototypeNonNegativeValueSchema,
  easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "spring"]),
}).strict();

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function duplicateValues(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function childIds(node: z.infer<typeof prototypeNodeSchema>) {
  return node.kind === "frame" || node.kind === "form" || node.kind === "button"
    ? node.childIds
    : [];
}

function tokenId(value: z.infer<typeof prototypeNumberValueSchema> | z.infer<typeof prototypeColorValueSchema> | z.infer<typeof prototypeStringValueSchema>) {
  return value.kind === "token" ? value.tokenId : null;
}

function styleTokenReferences(style: z.infer<typeof prototypeStyleSchema>) {
  return [
    [tokenId(style.fill ?? { kind: "literal", value: "#000000" }), ["color"]],
    [style.stroke ? tokenId(style.stroke.color) : null, ["color"]],
    [style.stroke ? tokenId(style.stroke.width) : null, ["number", "borderWidth"]],
    [tokenId(style.radii.topLeft), ["number", "radius"]],
    [tokenId(style.radii.topRight), ["number", "radius"]],
    [tokenId(style.radii.bottomRight), ["number", "radius"]],
    [tokenId(style.radii.bottomLeft), ["number", "radius"]],
    ...(style.typography ? [
      [tokenId(style.typography.fontFamily), ["fontFamily"]],
      [tokenId(style.typography.fontSize), ["number", "fontSize"]],
      [tokenId(style.typography.fontWeight), ["fontWeight"]],
      [tokenId(style.typography.lineHeight), ["number", "lineHeight"]],
      [tokenId(style.typography.letterSpacing), ["number", "spacing"]],
    ] : []),
    ...style.shadowTokenIds.map((id) => [id, ["shadow"]]),
  ] as Array<[string | null, string[]]>;
}

function layoutTokenReferences(layout: z.infer<typeof prototypeLayoutSchema>) {
  return [
    tokenId(layout.x), tokenId(layout.y), tokenId(layout.width), tokenId(layout.height), tokenId(layout.gap),
    tokenId(layout.padding.top), tokenId(layout.padding.right), tokenId(layout.padding.bottom), tokenId(layout.padding.left),
  ].filter((id): id is string => id !== null);
}

function bindingSourceValue(
  binding: z.infer<typeof prototypeBindingSchema>,
  variables: Map<string, z.infer<typeof prototypeVariableSchema>>,
  states: Map<string, z.infer<typeof prototypeStateSchema>>,
) {
  if (binding.source.kind === "literal") return binding.source.value;
  if (binding.source.kind === "variable") return variables.get(binding.source.path)?.initialValue;
  if (binding.source.kind === "expression") {
    return evaluatePrototypeExpression(binding.source.expression, (path) => variables.get(path)?.initialValue);
  }
  return states.get(binding.source.stateId)?.values[binding.source.field];
}

function bindingPropertyAllowedOnNode(
  property: z.infer<typeof prototypeBindingSchema>["property"],
  node: z.infer<typeof prototypeNodeSchema>,
) {
  if (property === "visible") return true;
  if (property === "enabled") return node.kind === "button" || node.kind === "input";
  if (property === "value") return node.kind === "input";
  if (property === "imageAssetId") return node.kind === "image";
  return node.kind === "text" || node.kind === "button";
}

function bindingValueAllowedForProperty(
  property: z.infer<typeof prototypeBindingSchema>["property"],
  value: z.infer<typeof prototypeRuntimeValueSchema> | undefined,
) {
  if (value === undefined || value === null) return true;
  if (property === "visible" || property === "enabled") return typeof value === "boolean";
  if (property === "imageAssetId") return typeof value === "string";
  return true;
}

const prototypeDocumentShape = {
  protocol: z.literal("workbench.prototype.v1"),
  documentId: artifactIrIdSchema,
  title: z.string().min(1).max(240),
  revision: z.number().int().positive(),
  screens: z.array(prototypeScreenSchema).min(1).max(500),
  nodes: z.array(prototypeNodeSchema).min(1).max(20_000),
  tokens: z.array(prototypeTokenSchema).max(2_000),
  assets: z.array(prototypeAssetSchema).max(2_000),
  variables: z.array(prototypeVariableSchema).max(2_000),
  states: z.array(prototypeStateSchema).max(5_000),
  actions: z.array(prototypeActionSchema).max(10_000),
  bindings: z.array(prototypeBindingSchema).max(10_000),
  motions: z.array(prototypeMotionSchema).max(10_000),
} as const;

const publicPrototypeDocumentBaseSchema = z.object({
  ...prototypeDocumentShape,
  assets: z.array(publicPrototypeAssetSchema).max(2_000),
}).strict();

const prototypeDocumentBaseSchema = z.object(prototypeDocumentShape).strict();

function refinePrototypeDocument(
  document: z.infer<typeof publicPrototypeDocumentBaseSchema>,
  context: z.RefinementCtx,
) {
  const screens = new Map(document.screens.map((screen) => [screen.id, screen]));
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const tokens = new Map(document.tokens.map((token) => [token.id, token]));
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
  const states = new Map(document.states.map((state) => [state.id, state]));
  const actions = new Map(document.actions.map((action) => [action.id, action]));
  const bindings = new Map(document.bindings.map((binding) => [binding.id, binding]));
  const motions = new Map(document.motions.map((motion) => [motion.id, motion]));
  const variables = new Map(document.variables.map((variable) => [variable.path, variable]));
  const variableIndexes = new Map(document.variables.map((variable, index) => [variable.path, index]));
  const nearestFormId = (nodeId: string) => {
    const visited = new Set<string>();
    let current = nodes.get(nodeId);
    while (current?.parentId) {
      if (visited.has(current.parentId)) return null;
      visited.add(current.parentId);
      const parent = nodes.get(current.parentId);
      if (!parent) return null;
      if (parent.kind === "form") return parent.id;
      current = parent;
    }
    return null;
  };
  const vectorPathIds = document.nodes.flatMap((node) => node.kind === "vector" ? node.paths.map((path) => path.id) : []);
  const allIds = [
    document.documentId,
    ...document.screens.map((screen) => screen.id),
    ...document.nodes.map((node) => node.id),
    ...document.tokens.map((token) => token.id),
    ...document.assets.map((asset) => asset.id),
    ...document.states.map((state) => state.id),
    ...document.actions.map((action) => action.id),
    ...document.bindings.map((binding) => binding.id),
    ...document.motions.map((motion) => motion.id),
    ...vectorPathIds,
  ];
  for (const duplicate of duplicateValues(allIds)) addIssue(context, [], `IR id must be globally unique: ${duplicate}`);
  for (const duplicate of duplicateValues(document.screens.map((screen) => screen.route))) addIssue(context, ["screens"], `screen route must be unique: ${duplicate}`);
  for (const duplicate of duplicateValues(document.variables.map((variable) => variable.path))) addIssue(context, ["variables"], `variable path must be unique: ${duplicate}`);
  for (const duplicate of duplicateValues(document.bindings.map((binding) => `${binding.nodeId}\u0000${binding.property}`))) {
    const [nodeId, property] = duplicate.split("\u0000");
    addIssue(context, ["bindings"], `node ${nodeId} may define only one ${property} binding`);
  }
  for (const duplicate of duplicateValues(document.actions.map((action) => (
    `${action.nodeId}\u0000${action.event === "click" || action.event === "press" ? "activation" : action.event}`
  )))) {
    const [nodeId, event] = duplicate.split("\u0000");
    addIssue(context, ["actions"], `node ${nodeId} may define only one ${event} action`);
  }

  const rootIds = new Set<string>();
  for (const [screenIndex, screen] of document.screens.entries()) {
    const root = nodes.get(screen.rootNodeId);
    if (!root) {
      addIssue(context, ["screens", screenIndex, "rootNodeId"], `unknown root node: ${screen.rootNodeId}`);
    } else {
      rootIds.add(root.id);
      if (root.kind !== "frame") addIssue(context, ["screens", screenIndex, "rootNodeId"], "screen root node must be a frame");
      if (root.parentId !== null) addIssue(context, ["screens", screenIndex, "rootNodeId"], "screen root node must not have a parent");
      if (root.screenId !== screen.id) addIssue(context, ["screens", screenIndex, "rootNodeId"], "screen root node must belong to the screen");
    }
    if (screen.initialStateId !== null) {
      const state = states.get(screen.initialStateId);
      if (!state) addIssue(context, ["screens", screenIndex, "initialStateId"], `unknown state: ${screen.initialStateId}`);
      else if (state.screenId !== screen.id) addIssue(context, ["screens", screenIndex, "initialStateId"], "initial state must belong to the screen");
    }
  }

  const attachedChildIds = new Set<string>();
  for (const [nodeIndex, node] of document.nodes.entries()) {
    const screen = screens.get(node.screenId);
    if (!screen) addIssue(context, ["nodes", nodeIndex, "screenId"], `unknown screen: ${node.screenId}`);
    if (node.parentId === null) {
      if (!rootIds.has(node.id)) addIssue(context, ["nodes", nodeIndex, "parentId"], "only screen root nodes may have a null parent");
    } else {
      const parent = nodes.get(node.parentId);
      if (!parent) addIssue(context, ["nodes", nodeIndex, "parentId"], `unknown parent node: ${node.parentId}`);
      else {
        if (parent.screenId !== node.screenId) addIssue(context, ["nodes", nodeIndex, "parentId"], "parent and child must belong to the same screen");
        if (!childIds(parent).includes(node.id)) addIssue(context, ["nodes", nodeIndex, "parentId"], "parent childIds must include the node");
      }
    }
    for (const duplicate of duplicateValues(childIds(node))) addIssue(context, ["nodes", nodeIndex, "childIds"], `duplicate child: ${duplicate}`);
    for (const duplicate of duplicateValues(node.actionIds)) addIssue(context, ["nodes", nodeIndex, "actionIds"], `duplicate action reference: ${duplicate}`);
    for (const duplicate of duplicateValues(node.bindingIds)) addIssue(context, ["nodes", nodeIndex, "bindingIds"], `duplicate binding reference: ${duplicate}`);
    for (const duplicate of duplicateValues(node.motionIds)) addIssue(context, ["nodes", nodeIndex, "motionIds"], `duplicate motion reference: ${duplicate}`);
    for (const childId of childIds(node)) {
      const child = nodes.get(childId);
      if (!child) addIssue(context, ["nodes", nodeIndex, "childIds"], `unknown child node: ${childId}`);
      else {
        if (attachedChildIds.has(childId)) addIssue(context, ["nodes", nodeIndex, "childIds"], `node has more than one parent: ${childId}`);
        attachedChildIds.add(childId);
        if (child.parentId !== node.id) addIssue(context, ["nodes", nodeIndex, "childIds"], `child ${childId} must point back to parent ${node.id}`);
        if (child.screenId !== node.screenId) addIssue(context, ["nodes", nodeIndex, "childIds"], "parent and child must belong to the same screen");
      }
    }
    if (node.kind === "form" && nearestFormId(node.id) !== null) {
      addIssue(context, ["nodes", nodeIndex, "parentId"], "form nodes must not be nested inside another form");
    }
    if (node.kind === "image") {
      const asset = assets.get(node.assetId);
      if (!asset || asset.kind !== "image") addIssue(context, ["nodes", nodeIndex, "assetId"], `unknown image asset: ${node.assetId}`);
    } else if (node.kind === "icon") {
      const asset = assets.get(node.assetId);
      if (!asset || asset.kind !== "icon") addIssue(context, ["nodes", nodeIndex, "assetId"], `unknown icon asset: ${node.assetId}`);
    } else if (node.kind === "input") {
      if (node.inputType === "select") {
        if (node.options.length === 0) addIssue(context, ["nodes", nodeIndex, "options"], "select input requires at least one option");
        for (const duplicate of duplicateValues(node.options.map((option) => option.value))) {
          addIssue(context, ["nodes", nodeIndex, "options"], `select option value must be unique: ${duplicate}`);
        }
      } else if (node.options.length > 0) {
        addIssue(context, ["nodes", nodeIndex, "options"], "only select inputs may declare options");
      }
      if (node.inputType === "radio") {
        if (node.optionValue === null) {
          addIssue(context, ["nodes", nodeIndex, "optionValue"], "radio input requires an optionValue");
        }
      } else if (node.optionValue !== null) {
        addIssue(context, ["nodes", nodeIndex, "optionValue"], "only radio inputs may declare optionValue");
      }

      const valueBindings = node.bindingIds.flatMap((bindingId) => {
        const binding = bindings.get(bindingId);
        return binding?.property === "value" ? [binding] : [];
      });
      if (valueBindings.length !== 1 || valueBindings[0]?.source.kind !== "variable") {
        addIssue(
          context,
          ["nodes", nodeIndex, "bindingIds"],
          "every input requires exactly one variable-backed value binding",
        );
      } else {
        const variablePath = valueBindings[0].source.path;
        const variableIndex = variableIndexes.get(variablePath);
        const initialValue = variables.get(variablePath)?.initialValue;
        const initialTypeAllowed = node.inputType === "checkbox"
          ? typeof initialValue === "boolean"
          : node.inputType === "radio"
            ? initialValue === null || typeof initialValue === "string"
            : node.inputType === "number"
              ? initialValue === null || typeof initialValue === "number"
              : node.inputType === "date"
                ? isCanonicalPrototypeDateInputValue(initialValue)
                : typeof initialValue === "string";
        if (!initialTypeAllowed) {
          const expectedType = node.inputType === "checkbox"
            ? "boolean"
            : node.inputType === "radio"
              ? "string or null"
              : node.inputType === "number"
                ? "number or null"
                : node.inputType === "date"
                  ? "an empty string or a canonical YYYY-MM-DD calendar date"
                  : "string";
          const receivedType = initialValue === null ? "null" : typeof initialValue;
          addIssue(
            context,
            variableIndex === undefined
              ? ["nodes", nodeIndex, "bindingIds"]
              : ["variables", variableIndex, "initialValue"],
            `${node.inputType} input variable ${variablePath} initialValue must be ${expectedType}; received ${receivedType}`,
          );
        }
        if (
          node.inputType === "select"
          && typeof initialValue === "string"
          && initialValue !== ""
          && !node.options.some((option) => option.value === initialValue)
        ) {
          addIssue(context, ["nodes", nodeIndex, "options"], "select initial value must match one declared option");
        }
      }
    } else if (node.kind === "button") {
      if (node.buttonType !== "button" && nearestFormId(node.id) === null) {
        addIssue(context, ["nodes", nodeIndex, "buttonType"], `${node.buttonType} button must belong to a form node`);
      }
      for (const [childIndex, childId] of node.childIds.entries()) {
        const child = nodes.get(childId);
        if (child && !["icon", "image", "vector"].includes(child.kind)) {
          addIssue(
            context,
            ["nodes", nodeIndex, "childIds", childIndex],
            "button children must be non-interactive leaf content",
          );
        }
      }
    }
    for (const actionId of node.actionIds) {
      const action = actions.get(actionId);
      if (!action) addIssue(context, ["nodes", nodeIndex, "actionIds"], `unknown action: ${actionId}`);
      else if (action.nodeId !== node.id) addIssue(context, ["nodes", nodeIndex, "actionIds"], `action ${actionId} must point back to node ${node.id}`);
    }
    for (const bindingId of node.bindingIds) {
      const binding = bindings.get(bindingId);
      if (!binding) addIssue(context, ["nodes", nodeIndex, "bindingIds"], `unknown binding: ${bindingId}`);
      else if (binding.nodeId !== node.id) addIssue(context, ["nodes", nodeIndex, "bindingIds"], `binding ${bindingId} must point back to node ${node.id}`);
    }
    for (const motionId of node.motionIds) {
      const motion = motions.get(motionId);
      if (!motion) addIssue(context, ["nodes", nodeIndex, "motionIds"], `unknown motion: ${motionId}`);
      else if (motion.nodeId !== node.id) addIssue(context, ["nodes", nodeIndex, "motionIds"], `motion ${motionId} must point back to node ${node.id}`);
    }
    for (const reference of layoutTokenReferences(node.layout)) {
      const token = tokens.get(reference);
      if (!token || !["number", "spacing", "radius", "fontSize", "lineHeight", "borderWidth"].includes(token.type)) {
        addIssue(context, ["nodes", nodeIndex, "layout"], `unknown or incompatible numeric token: ${reference}`);
      }
    }
    for (const [reference, allowedTypes] of styleTokenReferences(node.style)) {
      if (reference === null) continue;
      const token = tokens.get(reference);
      if (!token || !allowedTypes.includes(token.type)) addIssue(context, ["nodes", nodeIndex, "style"], `unknown or incompatible token: ${reference}`);
    }
  }

  const variableInputNodes = new Map<string, Array<Extract<z.infer<typeof prototypeNodeSchema>, { kind: "input" }>>>();
  for (const binding of document.bindings) {
    const node = nodes.get(binding.nodeId);
    if (
      node?.kind !== "input"
      || binding.property !== "value"
      || binding.source.kind !== "variable"
    ) continue;
    const inputNodes = variableInputNodes.get(binding.source.path) ?? [];
    inputNodes.push(node);
    variableInputNodes.set(binding.source.path, inputNodes);
  }
  for (const [path, inputNodes] of variableInputNodes) {
    if (inputNodes.length <= 1) continue;
    const radioGroupKeys = new Set(inputNodes.map((node) => node.inputType === "radio"
      ? `${node.screenId}\u0000${nearestFormId(node.id) ?? ""}\u0000${node.fieldName}`
      : `non-radio:${node.id}`));
    if (radioGroupKeys.size !== 1 || inputNodes.some((node) => node.inputType !== "radio")) {
      addIssue(context, ["bindings"], `input variable ${path} may be shared only by one radio field`);
    }
  }

  const radioGroups = new Map<string, Array<Extract<z.infer<typeof prototypeNodeSchema>, { kind: "input" }>>>();
  for (const node of document.nodes) {
    if (node.kind !== "input" || node.inputType !== "radio") continue;
    const key = `${node.screenId}\u0000${nearestFormId(node.id) ?? ""}\u0000${node.fieldName}`;
    const group = radioGroups.get(key) ?? [];
    group.push(node);
    radioGroups.set(key, group);
  }
  for (const group of radioGroups.values()) {
    const optionValues = group.flatMap((node) => node.optionValue === null ? [] : [node.optionValue]);
    for (const duplicate of duplicateValues(optionValues)) {
      addIssue(context, ["nodes"], `radio optionValue must be unique within its field: ${duplicate}`);
    }
    const variablePaths = new Set(group.flatMap((node) => node.bindingIds.flatMap((bindingId) => {
      const binding = bindings.get(bindingId);
      return binding?.property === "value" && binding.source.kind === "variable"
        ? [binding.source.path]
        : [];
    })));
    if (variablePaths.size !== 1) {
      addIssue(context, ["nodes"], "radio inputs in one field must share one variable-backed value binding");
      continue;
    }
    const [variablePath] = variablePaths;
    const initialValue = variablePath === undefined ? undefined : variables.get(variablePath)?.initialValue;
    if (
      initialValue !== null
      && typeof initialValue === "string"
      && !optionValues.includes(initialValue)
    ) {
      addIssue(context, ["nodes"], "radio initial value must match one optionValue in its field");
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      addIssue(context, ["nodes"], `node hierarchy contains a cycle at ${nodeId}`);
      return;
    }
    if (visited.has(nodeId)) return;
    const node = nodes.get(nodeId);
    if (!node) return;
    visiting.add(nodeId);
    for (const childId of childIds(node)) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const rootId of rootIds) visit(rootId);
  for (const node of document.nodes) if (!visited.has(node.id)) addIssue(context, ["nodes"], `node must be reachable from its screen root: ${node.id}`);

  for (const [stateIndex, state] of document.states.entries()) {
    if (!screens.has(state.screenId)) addIssue(context, ["states", stateIndex, "screenId"], `unknown screen: ${state.screenId}`);
    const overrideNodes = state.overrides.map((override) => override.nodeId);
    for (const duplicate of duplicateValues(overrideNodes)) addIssue(context, ["states", stateIndex, "overrides"], `duplicate state override: ${duplicate}`);
    for (const [overrideIndex, override] of state.overrides.entries()) {
      const node = nodes.get(override.nodeId);
      if (!node) addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "nodeId"], `unknown node: ${override.nodeId}`);
      else {
        if (node.screenId !== state.screenId) addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "nodeId"], "state override node must belong to the same screen");
        if (override.enabled !== undefined && node.kind !== "button" && node.kind !== "input") {
          addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "enabled"], `enabled override is not supported by ${node.kind} nodes`);
        }
        if (override.text !== undefined && node.kind !== "text" && node.kind !== "button") {
          addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "text"], `text override is not supported by ${node.kind} nodes`);
        }
        if (override.assetId !== undefined && node.kind !== "image") {
          addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "assetId"], `asset override is not supported by ${node.kind} nodes`);
        }
      }
      if (override.assetId !== undefined) {
        const asset = assets.get(override.assetId);
        if (!asset || asset.kind !== "image") {
          addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "assetId"], `unknown image asset: ${override.assetId}`);
        }
      }
      if (override.style) {
        for (const [reference, allowedTypes] of styleTokenReferences(override.style)) {
          if (reference === null) continue;
          const token = tokens.get(reference);
          if (!token || !allowedTypes.includes(token.type)) addIssue(context, ["states", stateIndex, "overrides", overrideIndex, "style"], `unknown or incompatible token: ${reference}`);
        }
      }
    }
  }

  for (const [actionIndex, action] of document.actions.entries()) {
    const node = nodes.get(action.nodeId);
    if (!node) addIssue(context, ["actions", actionIndex, "nodeId"], `unknown node: ${action.nodeId}`);
    else if (!node.actionIds.includes(action.id)) addIssue(context, ["actions", actionIndex, "nodeId"], `node ${action.nodeId} must reference action ${action.id}`);
    if (["change", "focus", "blur"].includes(action.event) && node?.kind !== "input") {
      addIssue(context, ["actions", actionIndex, "event"], `${action.event} actions require an input node`);
    }
    if (action.kind === "navigate" && !screens.has(action.targetScreenId)) addIssue(context, ["actions", actionIndex, "targetScreenId"], `unknown screen: ${action.targetScreenId}`);
    if (action.kind === "setState") {
      const state = states.get(action.targetStateId);
      if (!state) addIssue(context, ["actions", actionIndex, "targetStateId"], `unknown state: ${action.targetStateId}`);
      else if (node && state.screenId !== node.screenId) addIssue(context, ["actions", actionIndex, "targetStateId"], "state action must stay within the node screen");
    }
    if (action.kind === "submit") {
      const submittedFieldNames: string[] = [];
      for (const duplicate of duplicateValues(action.bindingIds)) {
        addIssue(context, ["actions", actionIndex, "bindingIds"], `duplicate submit binding: ${duplicate}`);
      }
      if (node?.kind !== "form" || action.event !== "submit") {
        addIssue(context, ["actions", actionIndex], "submit action must use the submit event on a form node");
      }
      for (const bindingId of action.bindingIds) {
        const binding = bindings.get(bindingId);
        if (!binding) {
          addIssue(context, ["actions", actionIndex, "bindingIds"], `unknown binding: ${bindingId}`);
          continue;
        }
        const input = nodes.get(binding.nodeId);
        if (input?.kind !== "input" || !node || nearestFormId(input.id) !== node.id) {
          addIssue(context, ["actions", actionIndex, "bindingIds"], `submit binding ${bindingId} must target an input inside form ${action.nodeId}`);
        } else {
          submittedFieldNames.push(input.fieldName);
        }
        if (binding.property !== "value") {
          addIssue(context, ["actions", actionIndex, "bindingIds"], `submit binding ${bindingId} must target an input value`);
        }
      }
      for (const duplicate of duplicateValues(submittedFieldNames)) {
        addIssue(context, ["actions", actionIndex, "bindingIds"], `submit field must be unique: ${duplicate}`);
      }
      if (action.successStateId !== null) {
        const successState = states.get(action.successStateId);
        if (!successState) {
          addIssue(context, ["actions", actionIndex, "successStateId"], `unknown state: ${action.successStateId}`);
        } else if (node && successState.screenId !== node.screenId) {
          addIssue(context, ["actions", actionIndex, "successStateId"], "submit success state must belong to the form screen");
        }
      }
    } else if (action.event === "submit") {
      addIssue(context, ["actions", actionIndex, "event"], "submit events require a submit action");
    }
  }

  for (const [bindingIndex, binding] of document.bindings.entries()) {
    const node = nodes.get(binding.nodeId);
    if (!node) addIssue(context, ["bindings", bindingIndex, "nodeId"], `unknown node: ${binding.nodeId}`);
    else {
      if (!node.bindingIds.includes(binding.id)) addIssue(context, ["bindings", bindingIndex, "nodeId"], `node ${binding.nodeId} must reference binding ${binding.id}`);
      if (!bindingPropertyAllowedOnNode(binding.property, node)) {
        addIssue(context, ["bindings", bindingIndex, "property"], `${binding.property} binding is not supported by ${node.kind} nodes`);
      }
    }
    if (binding.source.kind === "state") {
      const state = states.get(binding.source.stateId);
      if (!state) addIssue(context, ["bindings", bindingIndex, "source", "stateId"], `unknown state: ${binding.source.stateId}`);
      else if (node && state.screenId !== node.screenId) addIssue(context, ["bindings", bindingIndex, "source", "stateId"], "state binding must stay within the node screen");
      else if (!(binding.source.field in state.values)) addIssue(context, ["bindings", bindingIndex, "source", "field"], `unknown state value: ${binding.source.field}`);
    } else if (binding.source.kind === "variable" && !variables.has(binding.source.path)) {
      addIssue(context, ["bindings", bindingIndex, "source", "path"], `unknown variable: ${binding.source.path}`);
    }
    if (binding.source.kind === "expression") {
      if (!["text", "visible", "enabled"].includes(binding.property)) {
        addIssue(context, ["bindings", bindingIndex, "property"], "expression bindings may target only text, visible, or enabled");
        continue;
      }
      const missingPaths = prototypeExpressionVariablePaths(binding.source.expression)
        .filter((path) => !variables.has(path));
      if (missingPaths.length > 0) {
        for (const path of missingPaths) {
          addIssue(context, ["bindings", bindingIndex, "source", "expression"], `unknown expression variable: ${path}`);
        }
        continue;
      }
    }
    let sourceValue: PrototypeRuntimeValue | undefined;
    try {
      sourceValue = bindingSourceValue(binding, variables, states);
    } catch {
      addIssue(
        context,
        ["bindings", bindingIndex, "source", "expression"],
        "expression operands have incompatible types: contains requires strings and and/or/not require booleans",
      );
      continue;
    }
    if (
      binding.source.kind === "expression"
      && typeof sourceValue !== (binding.property === "text" ? "string" : "boolean")
    ) {
      addIssue(context, ["bindings", bindingIndex, "source", "expression"], `${binding.property} expression must evaluate to ${binding.property === "text" ? "string" : "boolean"}`);
      continue;
    }
    if (!bindingValueAllowedForProperty(binding.property, sourceValue)) {
      addIssue(context, ["bindings", bindingIndex, "source"], `${binding.property} binding has an incompatible value type`);
    }
    if (binding.property === "imageAssetId" && typeof sourceValue === "string") {
      const asset = assets.get(sourceValue);
      if (!asset || asset.kind !== "image") {
        addIssue(context, ["bindings", bindingIndex, "source"], `unknown image asset: ${sourceValue}`);
      }
    }
    if (binding.property === "imageAssetId" && binding.source.kind === "variable") {
      const inputNodes = variableInputNodes.get(binding.source.path) ?? [];
      if (inputNodes.some((input) => (
        input.inputType !== "select"
        || input.options.some((option) => assets.get(option.value)?.kind !== "image")
      ))) {
        addIssue(
          context,
          ["bindings", bindingIndex, "source"],
          "writable imageAssetId variables require image-only select options",
        );
      }
    }
  }

  for (const [motionIndex, motion] of document.motions.entries()) {
    const node = nodes.get(motion.nodeId);
    if (!node) addIssue(context, ["motions", motionIndex, "nodeId"], `unknown node: ${motion.nodeId}`);
    else if (!node.motionIds.includes(motion.id)) addIssue(context, ["motions", motionIndex, "nodeId"], `node ${motion.nodeId} must reference motion ${motion.id}`);
    if (motion.trigger === "stateChange" && motion.stateId === null) addIssue(context, ["motions", motionIndex, "stateId"], "stateChange motion requires stateId");
    if (motion.trigger !== "stateChange" && motion.stateId !== null) addIssue(context, ["motions", motionIndex, "stateId"], "stateId is only allowed for stateChange motions");
    if (motion.stateId !== null) {
      const state = states.get(motion.stateId);
      if (!state) addIssue(context, ["motions", motionIndex, "stateId"], `unknown state: ${motion.stateId}`);
      else if (node && state.screenId !== node.screenId) addIssue(context, ["motions", motionIndex, "stateId"], "motion state must stay within the node screen");
    }
    if (motion.trigger === "action" && motion.actionId === null) addIssue(context, ["motions", motionIndex, "actionId"], "action motion requires actionId");
    if (motion.trigger !== "action" && motion.actionId !== null) addIssue(context, ["motions", motionIndex, "actionId"], "actionId is only allowed for action motions");
    if (motion.actionId !== null && !actions.has(motion.actionId)) addIssue(context, ["motions", motionIndex, "actionId"], `unknown action: ${motion.actionId}`);
    if (motion.actionId !== null) {
      const action = actions.get(motion.actionId);
      const actionNode = action ? nodes.get(action.nodeId) : undefined;
      if (node && actionNode && node.screenId !== actionNode.screenId) {
        addIssue(context, ["motions", motionIndex, "actionId"], "action motion must stay within the action screen");
      }
    }
    for (const value of [motion.duration, motion.delay]) {
      const reference = tokenId(value);
      if (reference !== null) {
        const token = tokens.get(reference);
        if (!token || !["number", "duration"].includes(token.type)) addIssue(context, ["motions", motionIndex], `unknown or incompatible duration token: ${reference}`);
      }
    }
  }
}

export const publicPrototypeDocumentSchema = publicPrototypeDocumentBaseSchema
  .superRefine(refinePrototypeDocument);

export const prototypeDocumentSchema = prototypeDocumentBaseSchema
  .superRefine(refinePrototypeDocument);

export type PrototypeDocument = z.infer<typeof prototypeDocumentSchema>;
export type PublicPrototypeDocument = z.infer<typeof publicPrototypeDocumentSchema>;
export type PrototypeNumberValue = z.infer<typeof prototypeNumberValueSchema>;
export type PrototypeRotation = z.infer<typeof prototypeRotationSchema>;
export type PrototypeTransformOrigin = z.infer<typeof prototypeTransformOriginSchema>;
export type PrototypeStyle = z.infer<typeof prototypeStyleSchema>;
export type PrototypeNode = z.infer<typeof prototypeNodeSchema>;
export type PrototypeScreen = z.infer<typeof prototypeScreenSchema>;
export type PrototypeToken = z.infer<typeof prototypeTokenSchema>;
export type PrototypeAsset = z.infer<typeof prototypeAssetSchema>;
export type PrototypeState = z.infer<typeof prototypeStateSchema>;
export type PrototypeRuntimeValue = z.infer<typeof prototypeRuntimeValueSchema>;
export type PrototypeVariable = z.infer<typeof prototypeVariableSchema>;
export type PrototypeAction = z.infer<typeof prototypeActionSchema>;
export type PrototypeBinding = z.infer<typeof prototypeBindingSchema>;
export type PrototypeMotion = z.infer<typeof prototypeMotionSchema>;
export type PrototypeSubmitDetail = z.infer<typeof prototypeSubmitDetailSchema>;

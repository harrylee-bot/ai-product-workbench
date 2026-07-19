import { z } from "zod";

import {
  isoDateTimeSchema,
  jsonValueSchema,
  revisionSchema,
} from "./common.js";
import { canonicalJson } from "./canonical-json.js";

export const canvasAgentToolProtocol = "workbench.canvas-agent-tool.v1" as const;
export const canvasSnapshotProtocol = "workbench.canvas-snapshot.v1" as const;
export const canvasClientCommandProtocol = "workbench.canvas-client-command.v1" as const;
export const canvasClientCommandAckProtocol = "workbench.canvas-client-command-ack.v1" as const;
export const canvasClientStateProtocol = "workbench.canvas-client-state.v1" as const;
export const canvasAgentToolDescriptorProtocol = "workbench.canvas-agent-tool-descriptor.v1" as const;
export const canvasAgentToolReferenceProtocol = "workbench.canvas-agent-tool-reference.v1" as const;
export const canvasVisualCaptureProtocol = "workbench.canvas-visual-capture.v1" as const;

export const maximumCanvasScreenCount = 512;
export const maximumCanvasToolPageSize = 100;
export const maximumCanvasQuickEditInstructionLength = 8_000;

export const canvasAgentToolNames = [
  "get_visible_screens",
  "get_selected_screens",
  "view_screen",
  "select_screen",
  "quick_edit",
  "duplicate_screen",
  "rename_screen",
  "navigate_canvas",
] as const;

export const canvasAgentToolNameSchema = z.enum(canvasAgentToolNames);
export const canvasAgentCapabilitySchema = z.enum([
  "canvas:read",
  "canvas:interact",
  "artifact:edit",
  "run:create",
]);

export const canvasAgentIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !/^(?:https?|ftp|file|data|javascript|mailto):/iu.test(value), "Canvas ids cannot be URI schemes");
export const canvasAgentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const canvasClientSessionIdSchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !/^(?:https?|ftp|file|data|javascript|mailto):/iu.test(value), "Canvas client session ids cannot be URI schemes");
// Model/runtime tool ids are opaque provider values and may be longer than
// entity ids, but remain constrained to a header-safe identifier alphabet.
export const canvasToolCallIdSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !/^(?:https?|ftp|file|data|javascript|mailto):/iu.test(value), "Canvas tool call ids cannot be URI schemes");

const canvasCursorSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);
const canvasTitleSchema = z.string().trim().min(1).max(160);
const canvasScreenNameSchema = z.string().trim().min(1).max(240);
const canvasRouteSchema = z.string()
  .min(1)
  .max(1_024)
  .regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/u);

export const canvasViewportSchema = z.object({
  x: z.number().finite().min(-10_000_000).max(10_000_000),
  y: z.number().finite().min(-10_000_000).max(10_000_000),
  zoom: z.number().finite().min(0.01).max(64),
}).strict();

export const canvasScreenReferenceSchema = z.object({
  boardNodeId: canvasAgentIdSchema,
  artifactId: canvasAgentIdSchema,
  artifactVersionId: canvasAgentIdSchema,
  screenId: canvasAgentIdSchema,
}).strict();

export const canvasScreenSummarySchema = z.object({
  reference: canvasScreenReferenceSchema,
  name: canvasScreenNameSchema,
  route: canvasRouteSchema,
  phase: z.enum(["generating", "complete"]),
  viewport: z.object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  }).strict(),
}).strict();

export const canvasScreenViewSchema = z.object({
  screen: canvasScreenSummarySchema,
  structure: z.object({
    nodeCount: z.number().int().nonnegative().max(100_000),
    actionCount: z.number().int().nonnegative().max(100_000),
    stateCount: z.number().int().nonnegative().max(10_000),
    motionCount: z.number().int().nonnegative().max(100_000),
  }).strict(),
  visualCapabilityId: canvasAgentIdSchema.nullable(),
}).strict();

export const canvasSnapshotSchema = z.object({
  protocol: z.literal(canvasSnapshotProtocol),
  projectId: canvasAgentIdSchema,
  threadId: canvasAgentIdSchema,
  runId: canvasAgentIdSchema.nullable(),
  boardId: canvasAgentIdSchema,
  clientSessionId: canvasClientSessionIdSchema,
  projectSessionGeneration: revisionSchema,
  boardRevision: revisionSchema,
  canvasStateRevision: revisionSchema,
  capturedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  viewport: canvasViewportSchema,
  screens: z.array(canvasScreenSummarySchema).max(maximumCanvasScreenCount),
  visibleScreens: z.array(canvasScreenReferenceSchema).max(maximumCanvasScreenCount),
  selectedScreens: z.array(canvasScreenReferenceSchema).max(maximumCanvasScreenCount),
}).strict().superRefine((snapshot, context) => {
  if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.capturedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Canvas snapshot expiry must follow capture time",
    });
  }

  const screenKeys = new Set<string>();
  snapshot.screens.forEach((screen, index) => {
    const key = canvasScreenReferenceKey(screen.reference);
    if (screenKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["screens", index, "reference"],
        message: "Canvas snapshot screen references must be unique",
      });
    }
    screenKeys.add(key);
  });
  refineSnapshotReferences(snapshot.visibleScreens, "visibleScreens", screenKeys, context);
  refineSnapshotReferences(snapshot.selectedScreens, "selectedScreens", screenKeys, context);
});

export const canvasAgentSnapshotSchema = canvasSnapshotSchema;
export const canvasAgentScreenReferenceSchema = canvasScreenReferenceSchema;
export const canvasAgentScreenViewSchema = canvasScreenViewSchema;

export const canvasClientStateSyncRequestSchema = z.object({
  protocol: z.literal(canvasClientStateProtocol),
  clientSessionId: canvasClientSessionIdSchema,
  projectSessionGeneration: z.number().int().positive(),
  boardId: canvasAgentIdSchema,
  boardRevision: revisionSchema,
  canvasStateRevision: revisionSchema,
  viewport: canvasViewportSchema,
  visibleScreens: z.array(canvasScreenReferenceSchema).max(maximumCanvasScreenCount),
  selectedScreens: z.array(canvasScreenReferenceSchema).max(maximumCanvasScreenCount),
}).strict().superRefine((state, context) => {
  refineUniqueScreenReferences(state.visibleScreens, ["visibleScreens"], context);
  refineUniqueScreenReferences(state.selectedScreens, ["selectedScreens"], context);
});

export const canvasClientStateSyncResponseSchema = z.object({
  protocol: z.literal(canvasClientStateProtocol),
  activeSession: z.boolean(),
  canvasStateRevision: revisionSchema,
}).strict();

export const canvasAgentToolContextSchema = z.object({
  protocol: z.literal(canvasAgentToolProtocol),
  principalId: canvasAgentIdSchema,
  projectId: canvasAgentIdSchema,
  threadId: canvasAgentIdSchema,
  runId: canvasAgentIdSchema.nullable(),
  runtimeAttemptId: canvasAgentIdSchema.nullable(),
  agentSessionId: canvasAgentIdSchema,
  toolCallId: canvasToolCallIdSchema,
  requestId: canvasAgentIdSchema,
  traceId: canvasAgentIdSchema,
  clientSessionId: canvasClientSessionIdSchema.nullable(),
  projectSessionGeneration: revisionSchema,
  boardId: canvasAgentIdSchema,
  boardRevision: revisionSchema,
  canvasStateRevision: revisionSchema,
  declarationSha256: canvasAgentSha256Schema,
  capabilities: z.array(canvasAgentCapabilitySchema).max(4),
}).strict().superRefine((value, context) => {
  if (value.runtimeAttemptId !== null && value.runId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runtimeAttemptId"],
      message: "A runtime attempt requires a Run",
    });
  }
  refineUniqueStrings(value.capabilities, ["capabilities"], context);
});

export const canvasToolFailureSchema = z.object({
  code: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/u),
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
}).strict();

export const canvasGetVisibleScreensInputSchema = z.object({
  cursor: canvasCursorSchema.optional(),
  limit: z.number().int().min(1).max(maximumCanvasToolPageSize).optional(),
}).strict();

export const canvasGetVisibleScreensOutputSchema = z.object({
  items: z.array(canvasScreenSummarySchema).max(maximumCanvasToolPageSize),
  nextCursor: canvasCursorSchema.nullable(),
  truncated: z.boolean(),
  viewport: canvasViewportSchema,
}).strict();

export const canvasGetSelectedScreensInputSchema = z.object({}).strict();

export const canvasSelectionSchema = z.object({
  kind: z.enum(["none", "single", "multiple"]),
  items: z.array(canvasScreenSummarySchema).max(maximumCanvasScreenCount),
  truncated: z.boolean(),
}).strict().superRefine((selection, context) => {
  const expected = selection.items.length === 0
    ? "none"
    : selection.items.length === 1
      ? "single"
      : "multiple";
  if (selection.kind !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "Canvas selection kind must match its item count",
    });
  }
  refineUniqueScreenSummaries(selection.items, context);
});

export const canvasGetSelectedScreensOutputSchema = canvasSelectionSchema;

export const canvasViewScreenInputSchema = z.object({
  target: canvasScreenReferenceSchema,
}).strict();

export const canvasViewScreenOutputSchema = z.object({
  view: canvasScreenViewSchema,
}).strict();

// The command itself is issued with a server-created capability id. The
// browser may only fill that capability with a bounded, re-encoded image;
// the API never trusts the client metadata or stores the original bytes.
export const canvasVisualCaptureWireSchema = z.object({
  protocol: z.literal(canvasVisualCaptureProtocol),
  visualCapabilityId: canvasAgentIdSchema,
  mediaType: z.enum(["image/webp", "image/jpeg", "image/png"]),
  byteSize: z.number().int().positive().max(1_048_576),
  width: z.number().int().positive().max(2_048),
  height: z.number().int().positive().max(2_048),
  sha256: canvasAgentSha256Schema,
  dataBase64: z.string()
    .min(16)
    .max(1_500_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
}).strict();

export const canvasSelectionModeSchema = z.enum(["replace", "add", "remove", "toggle"]);

export const canvasSelectScreenInputSchema = z.object({
  targets: z.array(canvasScreenReferenceSchema).min(1).max(maximumCanvasScreenCount),
  mode: canvasSelectionModeSchema,
}).strict().superRefine((value, context) => {
  refineUniqueScreenReferences(value.targets, ["targets"], context);
});

export const canvasSelectScreenOutputSchema = z.object({
  selection: canvasSelectionSchema,
}).strict();

export const canvasQuickEditInputSchema = z.object({
  target: canvasScreenReferenceSchema,
  instruction: z.string().trim().min(1).max(maximumCanvasQuickEditInstructionLength),
}).strict();

export const canvasQuickEditOutputSchema = z.object({
  runId: canvasAgentIdSchema,
  target: canvasScreenReferenceSchema,
  accepted: z.literal(true),
}).strict();

export const canvasDuplicateScreenInputSchema = z.object({
  target: canvasScreenReferenceSchema,
}).strict();

export const canvasDuplicateScreenOutputSchema = z.object({
  runId: canvasAgentIdSchema,
  target: canvasScreenReferenceSchema,
  accepted: z.literal(true),
}).strict();

export const canvasRenameScreenInputSchema = z.object({
  target: canvasScreenReferenceSchema,
  title: canvasTitleSchema,
}).strict();

export const canvasRenameScreenOutputSchema = z.object({
  runId: canvasAgentIdSchema,
  target: canvasScreenReferenceSchema,
  title: canvasTitleSchema,
  accepted: z.literal(true),
}).strict();

export const canvasNavigationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("screen"), screen: canvasScreenReferenceSchema }).strict(),
  z.object({ kind: z.literal("selection") }).strict(),
  z.object({ kind: z.literal("all") }).strict(),
]);

export const canvasNavigateCanvasInputSchema = z.object({
  target: canvasNavigationTargetSchema,
  behavior: z.enum(["instant", "smooth"]),
}).strict();

export const canvasNavigateCanvasOutputSchema = z.object({
  viewport: canvasViewportSchema,
}).strict();

export const canvasAgentToolInputSchemas = Object.freeze({
  get_visible_screens: canvasGetVisibleScreensInputSchema,
  get_selected_screens: canvasGetSelectedScreensInputSchema,
  view_screen: canvasViewScreenInputSchema,
  select_screen: canvasSelectScreenInputSchema,
  quick_edit: canvasQuickEditInputSchema,
  duplicate_screen: canvasDuplicateScreenInputSchema,
  rename_screen: canvasRenameScreenInputSchema,
  navigate_canvas: canvasNavigateCanvasInputSchema,
});

export const canvasAgentToolOutputSchemas = Object.freeze({
  get_visible_screens: canvasGetVisibleScreensOutputSchema,
  get_selected_screens: canvasGetSelectedScreensOutputSchema,
  view_screen: canvasViewScreenOutputSchema,
  select_screen: canvasSelectScreenOutputSchema,
  quick_edit: canvasQuickEditOutputSchema,
  duplicate_screen: canvasDuplicateScreenOutputSchema,
  rename_screen: canvasRenameScreenOutputSchema,
  navigate_canvas: canvasNavigateCanvasOutputSchema,
});

// The capability token supplies trusted scope. DeerFlow only sends this
// minimal invocation envelope; the API reconstructs the full agent context
// from the verified grant instead of trusting model-provided scope fields.
export const canvasAgentToolInvocationSchema = z.object({
  protocol: z.literal(canvasAgentToolProtocol),
  toolName: canvasAgentToolNameSchema,
  toolCallId: canvasToolCallIdSchema,
  input: jsonValueSchema,
}).strict().superRefine((value, context) => {
  const schema = canvasAgentToolInputSchemas[value.toolName];
  const parsed = schema.safeParse(value.input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input", ...issue.path],
        message: issue.message,
      });
    }
  }
});

const canvasToolRequestBaseShape = {
  protocol: z.literal(canvasAgentToolProtocol),
  context: canvasAgentToolContextSchema,
};

export const canvasAgentToolRequestSchema = z.discriminatedUnion("toolName", [
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("get_visible_screens"), input: canvasGetVisibleScreensInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("get_selected_screens"), input: canvasGetSelectedScreensInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("view_screen"), input: canvasViewScreenInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("select_screen"), input: canvasSelectScreenInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("quick_edit"), input: canvasQuickEditInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("duplicate_screen"), input: canvasDuplicateScreenInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("rename_screen"), input: canvasRenameScreenInputSchema }).strict(),
  z.object({ ...canvasToolRequestBaseShape, toolName: z.literal("navigate_canvas"), input: canvasNavigateCanvasInputSchema }).strict(),
]);

const canvasToolResultBaseShape = {
  protocol: z.literal(canvasAgentToolProtocol),
  agentSessionId: canvasAgentIdSchema,
  toolCallId: canvasToolCallIdSchema,
  toolName: canvasAgentToolNameSchema,
  boardRevision: revisionSchema,
  canvasStateRevision: revisionSchema,
  responseSha256: canvasAgentSha256Schema,
};

export const canvasAgentToolResultStatusSchema = z.enum([
  "succeeded",
  "waiting_approval",
  "waiting_client",
  "failed",
  "cancelled",
]);

export const canvasAgentToolResultSchema = z.discriminatedUnion("status", [
  z.object({
    ...canvasToolResultBaseShape,
    status: z.literal("succeeded"),
    data: jsonValueSchema,
    failure: z.null(),
    approvalId: canvasAgentIdSchema.nullable(),
    clientCommandId: canvasAgentIdSchema.nullable(),
  }).strict(),
  z.object({
    ...canvasToolResultBaseShape,
    status: z.literal("waiting_approval"),
    data: z.null(),
    failure: z.null(),
    approvalId: canvasAgentIdSchema,
    clientCommandId: z.null(),
  }).strict(),
  z.object({
    ...canvasToolResultBaseShape,
    status: z.literal("waiting_client"),
    data: z.null(),
    failure: z.null(),
    approvalId: z.null(),
    clientCommandId: canvasAgentIdSchema,
  }).strict(),
  z.object({
    ...canvasToolResultBaseShape,
    status: z.literal("failed"),
    data: z.null(),
    failure: canvasToolFailureSchema,
    approvalId: z.null(),
    clientCommandId: z.null(),
  }).strict(),
  z.object({
    ...canvasToolResultBaseShape,
    status: z.literal("cancelled"),
    data: z.null(),
    failure: z.null(),
    approvalId: z.null(),
    clientCommandId: z.null(),
  }).strict(),
]).superRefine((result, context) => {
  if (result.status !== "succeeded") return;
  const outputSchema = canvasAgentToolOutputSchemas[result.toolName];
  const parsed = outputSchema.safeParse(result.data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", ...issue.path],
        message: issue.message,
      });
    }
  }
});

const canvasClientCommandBaseShape = {
  protocol: z.literal(canvasClientCommandProtocol),
  commandId: canvasAgentIdSchema,
  agentSessionId: canvasAgentIdSchema,
  toolCallId: canvasToolCallIdSchema,
  // requestId identifies one server dispatch; toolCallId remains the stable model idempotency key.
  requestId: canvasAgentIdSchema,
  projectId: canvasAgentIdSchema,
  threadId: canvasAgentIdSchema,
  runId: canvasAgentIdSchema.nullable(),
  boardId: canvasAgentIdSchema,
  clientSessionId: canvasClientSessionIdSchema,
  projectSessionGeneration: revisionSchema,
  boardRevision: revisionSchema,
  expectedCanvasStateRevision: revisionSchema,
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
};

const canvasClientPreviewCommandShape = {
  ...canvasClientCommandBaseShape,
  kind: z.literal("preview.open"),
  toolName: z.literal("view_screen"),
  target: canvasScreenReferenceSchema,
  // A command cannot be issued without a server-bound visual capability.
  view: canvasScreenViewSchema.extend({ visualCapabilityId: canvasAgentIdSchema }),
};

export const canvasClientCommandSchema = z.discriminatedUnion("kind", [
  z.object(canvasClientPreviewCommandShape).strict(),
  z.object({
    ...canvasClientCommandBaseShape,
    kind: z.literal("selection.change"),
    toolName: z.literal("select_screen"),
    targets: z.array(canvasScreenReferenceSchema).min(1).max(maximumCanvasScreenCount),
    mode: canvasSelectionModeSchema,
  }).strict(),
  z.object({
    ...canvasClientCommandBaseShape,
    kind: z.literal("viewport.navigate"),
    toolName: z.literal("navigate_canvas"),
    target: canvasNavigationTargetSchema,
    behavior: z.enum(["instant", "smooth"]),
  }).strict(),
]).superRefine((command, context) => {
  if (command.kind === "selection.change") {
    refineUniqueScreenReferences(command.targets, ["targets"], context);
  }
  if (Date.parse(command.expiresAt) <= Date.parse(command.issuedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "Canvas client command expiry must follow issue time",
    });
  }
});

export const canvasClientCommandListSchema = z.object({
  items: z.array(canvasClientCommandSchema).max(100),
  nextCursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).nullable(),
}).strict().superRefine((value, context) => {
  const commandIds = new Set<string>();
  value.items.forEach((command, index) => {
    if (commandIds.has(command.commandId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "commandId"],
        message: "Canvas client command list commandIds must be unique",
      });
    }
    commandIds.add(command.commandId);
  });
});

const canvasClientCommandAckBaseShape = {
  protocol: z.literal(canvasClientCommandAckProtocol),
  commandId: canvasAgentIdSchema,
  agentSessionId: canvasAgentIdSchema,
  toolCallId: canvasToolCallIdSchema,
  requestId: canvasAgentIdSchema,
  toolName: z.enum(["view_screen", "select_screen", "navigate_canvas"]),
  projectId: canvasAgentIdSchema,
  threadId: canvasAgentIdSchema,
  runId: canvasAgentIdSchema.nullable(),
  boardId: canvasAgentIdSchema,
  clientSessionId: canvasClientSessionIdSchema,
  projectSessionGeneration: revisionSchema,
  boardRevision: revisionSchema,
  canvasStateRevision: revisionSchema,
  acknowledgedAt: isoDateTimeSchema,
};

const canvasClientCommandAckAppliedShape = {
  ...canvasClientCommandAckBaseShape,
  status: z.literal("applied"),
  result: jsonValueSchema,
  failure: z.null(),
};

export const canvasClientCommandAckSchema = z.discriminatedUnion("status", [
  z.object(canvasClientCommandAckAppliedShape).strict(),
  z.object({
    ...canvasClientCommandAckBaseShape,
    status: z.literal("rejected"),
    result: z.null(),
    failure: canvasToolFailureSchema,
  }).strict(),
]);

/** Wire-only ACK contract. `visualCapture` is stripped before persistence. */
export const canvasClientCommandAckRequestSchema = z.discriminatedUnion("status", [
  z.object({
    ...canvasClientCommandAckAppliedShape,
    // Non-view commands may omit the field; view_screen is still required to
    // provide it by the refinement below.
    visualCapture: canvasVisualCaptureWireSchema.nullable().optional(),
  }).strict(),
  z.object({
    ...canvasClientCommandAckBaseShape,
    status: z.literal("rejected"),
    result: z.null(),
    failure: canvasToolFailureSchema,
    visualCapture: z.null().optional(),
  }).strict(),
]).superRefine((ack, context) => {
  if (ack.status !== "applied") return;
  const capture = ack.visualCapture;
  if (ack.toolName === "view_screen") {
    const parsed = canvasViewScreenOutputSchema.safeParse(ack.result);
    if (!parsed.success || !capture || parsed.data.view.visualCapabilityId !== capture.visualCapabilityId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["visualCapture"],
        message: "A view_screen ACK must include the command-bound visual capture",
      });
    }
  } else if (capture !== null && capture !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["visualCapture"],
      message: "Only view_screen ACKs may carry a visual capture",
    });
  }
});

// Agent-prefixed aliases keep the client dispatcher vocabulary explicit while
// preserving the shorter protocol names used by existing Web primitives.
export const canvasAgentClientCommandSchema = canvasClientCommandSchema;
export const canvasAgentClientCommandAckSchema = canvasClientCommandAckSchema;
export const canvasAgentClientCommandAckRequestSchema = canvasClientCommandAckRequestSchema;

export const canvasClientCommandExchangeSchema = z.object({
  command: canvasClientCommandSchema,
  ack: canvasClientCommandAckSchema,
}).strict().superRefine(({ command, ack }, context) => {
  const exactScopeFields = [
    "commandId",
    "agentSessionId",
    "toolCallId",
    "requestId",
    "toolName",
    "projectId",
    "threadId",
    "runId",
    "boardId",
    "clientSessionId",
    "projectSessionGeneration",
    "boardRevision",
  ] as const;
  for (const field of exactScopeFields) {
    if (command[field] !== ack[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ack", field],
        message: `Canvas command ACK ${field} must match its command`,
      });
    }
  }
  if (ack.canvasStateRevision < command.expectedCanvasStateRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ack", "canvasStateRevision"],
      message: "Canvas command ACK cannot use an older Canvas state revision",
    });
  }
  if (command.kind === "preview.open" && ack.status === "applied") {
    const parsed = canvasViewScreenOutputSchema.safeParse(ack.result);
    if (!parsed.success || canonicalJson(parsed.data.view) !== canonicalJson(command.view)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ack", "result"],
        message: "A view_screen ACK must return the server-authoritative screen view",
      });
    }
  }
});

export function canvasClientCommandAckMatchesCommand(
  command: z.input<typeof canvasClientCommandSchema>,
  ack: z.input<typeof canvasClientCommandAckSchema>,
): boolean {
  return canvasClientCommandExchangeSchema.safeParse({ command, ack }).success;
}

export function canvasClientCommandAckRequestMatchesCommand(
  command: z.input<typeof canvasClientCommandSchema>,
  ack: z.input<typeof canvasClientCommandAckRequestSchema>,
): boolean {
  const durable = ack.visualCapture === undefined || ack.visualCapture === null
    ? ack
    : { ...ack, visualCapture: undefined };
  const { visualCapture: _visualCapture, ...withoutCapture } = durable as Record<string, unknown>;
  return canvasClientCommandExchangeSchema.safeParse({ command, ack: withoutCapture }).success;
}

export const canvasAgentToolEffectSchema = z.enum(["read", "client_command", "mutation", "run"]);

export const canvasAgentToolProfileSchema = z.object({
  toolName: canvasAgentToolNameSchema,
  effect: canvasAgentToolEffectSchema,
  requiredCapabilities: z.array(canvasAgentCapabilitySchema).min(1).max(4),
  requiresFreshSnapshot: z.boolean(),
  requiresExistingScreen: z.boolean(),
  requiresSingleEditableSelection: z.boolean(),
  blockedByActiveMutation: z.boolean(),
  requiresEditModel: z.boolean(),
}).strict().superRefine((profile, context) => {
  refineUniqueStrings(profile.requiredCapabilities, ["requiredCapabilities"], context);
});

export type CanvasAgentToolProfile = z.infer<typeof canvasAgentToolProfileSchema>;

export const canvasAgentToolProfiles = Object.freeze({
  get_visible_screens: profile({
    toolName: "get_visible_screens",
    effect: "read",
    requiredCapabilities: ["canvas:read"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
  }),
  get_selected_screens: profile({
    toolName: "get_selected_screens",
    effect: "read",
    requiredCapabilities: ["canvas:read"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
  }),
  view_screen: profile({
    toolName: "view_screen",
    effect: "client_command",
    requiredCapabilities: ["canvas:read", "canvas:interact"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
  }),
  select_screen: profile({
    toolName: "select_screen",
    effect: "client_command",
    requiredCapabilities: ["canvas:interact"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
  }),
  quick_edit: profile({
    toolName: "quick_edit",
    effect: "run",
    requiredCapabilities: ["canvas:read", "artifact:edit", "run:create"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
    requiresSingleEditableSelection: true,
    blockedByActiveMutation: true,
    requiresEditModel: true,
  }),
  duplicate_screen: profile({
    toolName: "duplicate_screen",
    effect: "run",
    requiredCapabilities: ["canvas:read", "artifact:edit", "run:create"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
    requiresSingleEditableSelection: true,
    blockedByActiveMutation: true,
  }),
  rename_screen: profile({
    toolName: "rename_screen",
    effect: "run",
    requiredCapabilities: ["canvas:read", "artifact:edit", "run:create"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
    requiresSingleEditableSelection: true,
    blockedByActiveMutation: true,
  }),
  navigate_canvas: profile({
    toolName: "navigate_canvas",
    effect: "client_command",
    requiredCapabilities: ["canvas:interact"],
    requiresFreshSnapshot: true,
    requiresExistingScreen: true,
  }),
} satisfies Record<CanvasAgentToolName, CanvasAgentToolProfile>);

export const canvasAgentToolDeclarationContextSchema = z.object({
  capabilities: z.array(canvasAgentCapabilitySchema).max(4),
  hasFreshSnapshot: z.boolean(),
  screenCount: z.number().int().nonnegative().max(maximumCanvasScreenCount),
  selectedScreenCount: z.number().int().nonnegative().max(maximumCanvasScreenCount),
  selectedScreenEditable: z.boolean(),
  activeMutation: z.boolean(),
  editModelAvailable: z.boolean(),
}).strict().superRefine((value, context) => {
  refineUniqueStrings(value.capabilities, ["capabilities"], context);
  if (value.selectedScreenCount > value.screenCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedScreenCount"],
      message: "Selected screen count cannot exceed the screen count",
    });
  }
  if (value.selectedScreenEditable && value.selectedScreenCount !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedScreenEditable"],
      message: "An editable selection must contain exactly one screen",
    });
  }
});

export const canvasAgentDeclaredToolSchema = canvasAgentToolProfileSchema;
export const canvasAgentToolDeclarationSchema = canvasAgentDeclaredToolSchema;

export function declareCanvasAgentTools(
  value: z.input<typeof canvasAgentToolDeclarationContextSchema>,
): CanvasAgentToolProfile[] {
  const environment = canvasAgentToolDeclarationContextSchema.parse(value);
  const capabilities = new Set(environment.capabilities);
  return canvasAgentToolNames.flatMap((toolName) => {
    const candidate = canvasAgentToolProfiles[toolName];
    if (!candidate.requiredCapabilities.every((capability) => capabilities.has(capability))) return [];
    if (candidate.requiresFreshSnapshot && !environment.hasFreshSnapshot) return [];
    if (candidate.requiresExistingScreen && environment.screenCount === 0) return [];
    if (
      candidate.requiresSingleEditableSelection
      && (environment.selectedScreenCount !== 1 || !environment.selectedScreenEditable)
    ) return [];
    if (candidate.blockedByActiveMutation && environment.activeMutation) return [];
    if (candidate.requiresEditModel && !environment.editModelAvailable) return [];
    return [candidate];
  });
}

export function declaredCanvasAgentToolNames(
  value: z.input<typeof canvasAgentToolDeclarationContextSchema>,
): CanvasAgentToolName[] {
  return declareCanvasAgentTools(value).map((candidate) => candidate.toolName);
}

export const canvasAgentDeclaredToolNames = declaredCanvasAgentToolNames;

export const canvasAgentToolReferenceSchema = z.object({
  protocol: z.literal(canvasAgentToolReferenceProtocol),
  declarationRevision: revisionSchema,
  declarationSha256: canvasAgentSha256Schema,
  declaredTools: z.array(canvasAgentToolNameSchema).max(canvasAgentToolNames.length),
}).strict().superRefine((reference, context) => {
  refineUniqueStrings(reference.declaredTools, ["declaredTools"], context);
  const ordered = canvasAgentToolNames.filter((toolName) => reference.declaredTools.includes(toolName));
  if (ordered.some((toolName, index) => reference.declaredTools[index] !== toolName)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["declaredTools"],
      message: "Declared Canvas tools must use canonical order",
    });
  }
});

export const canvasAgentToolDescriptorSchema = z.object({
  protocol: z.literal(canvasAgentToolDescriptorProtocol),
  endpoint: z.string().url().max(2_048).superRefine((value, context) => {
    const url = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canvas tool endpoint must be a safe HTTP(S) URL",
      });
    }
  }),
  token: z.string().min(64).max(4_096).regex(/^wbct1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u),
  expiresAt: isoDateTimeSchema,
  visualEndpoint: z.string().url().max(2_048).superRefine((value, context) => {
    const url = new URL(value);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Canvas visual endpoint must be a safe HTTP(S) URL without query or fragment",
      });
    }
  }),
  reference: canvasAgentToolReferenceSchema,
}).strict();

export type CanvasAgentToolName = z.infer<typeof canvasAgentToolNameSchema>;
export type CanvasAgentCapability = z.infer<typeof canvasAgentCapabilitySchema>;
export type CanvasAgentToolContext = z.infer<typeof canvasAgentToolContextSchema>;
export type CanvasAgentToolRequest = z.infer<typeof canvasAgentToolRequestSchema>;
export type CanvasAgentToolInvocation = z.infer<typeof canvasAgentToolInvocationSchema>;
export type CanvasAgentToolResult = z.infer<typeof canvasAgentToolResultSchema>;
export type CanvasAgentToolReference = z.infer<typeof canvasAgentToolReferenceSchema>;
export type CanvasAgentToolDescriptor = z.infer<typeof canvasAgentToolDescriptorSchema>;
export type CanvasVisualCaptureWire = z.infer<typeof canvasVisualCaptureWireSchema>;
export type CanvasClientCommandAckRequest = z.infer<typeof canvasClientCommandAckRequestSchema>;
export type CanvasAgentToolDeclarationContext = z.infer<typeof canvasAgentToolDeclarationContextSchema>;
export type CanvasScreenReference = z.infer<typeof canvasScreenReferenceSchema>;
export type CanvasScreenSummary = z.infer<typeof canvasScreenSummarySchema>;
export type CanvasScreenView = z.infer<typeof canvasScreenViewSchema>;
export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>;
export type CanvasClientStateSyncRequest = z.infer<typeof canvasClientStateSyncRequestSchema>;
export type CanvasClientStateSyncResponse = z.infer<typeof canvasClientStateSyncResponseSchema>;
export type CanvasClientCommand = z.infer<typeof canvasClientCommandSchema>;
export type CanvasClientCommandList = z.infer<typeof canvasClientCommandListSchema>;
export type CanvasClientCommandAck = z.infer<typeof canvasClientCommandAckSchema>;
export type CanvasClientCommandExchange = z.infer<typeof canvasClientCommandExchangeSchema>;
export type CanvasAgentSnapshot = CanvasSnapshot;
export type CanvasAgentClientCommand = CanvasClientCommand;
export type CanvasAgentClientCommandAck = CanvasClientCommandAck;
export type CanvasAgentClientCommandExchange = CanvasClientCommandExchange;

export type CanvasAgentToolInputByName = {
  get_visible_screens: z.infer<typeof canvasGetVisibleScreensInputSchema>;
  get_selected_screens: z.infer<typeof canvasGetSelectedScreensInputSchema>;
  view_screen: z.infer<typeof canvasViewScreenInputSchema>;
  select_screen: z.infer<typeof canvasSelectScreenInputSchema>;
  quick_edit: z.infer<typeof canvasQuickEditInputSchema>;
  duplicate_screen: z.infer<typeof canvasDuplicateScreenInputSchema>;
  rename_screen: z.infer<typeof canvasRenameScreenInputSchema>;
  navigate_canvas: z.infer<typeof canvasNavigateCanvasInputSchema>;
};

export type CanvasAgentToolOutputByName = {
  get_visible_screens: z.infer<typeof canvasGetVisibleScreensOutputSchema>;
  get_selected_screens: z.infer<typeof canvasGetSelectedScreensOutputSchema>;
  view_screen: z.infer<typeof canvasViewScreenOutputSchema>;
  select_screen: z.infer<typeof canvasSelectScreenOutputSchema>;
  quick_edit: z.infer<typeof canvasQuickEditOutputSchema>;
  duplicate_screen: z.infer<typeof canvasDuplicateScreenOutputSchema>;
  rename_screen: z.infer<typeof canvasRenameScreenOutputSchema>;
  navigate_canvas: z.infer<typeof canvasNavigateCanvasOutputSchema>;
};

function profile(
  value: Omit<CanvasAgentToolProfile,
    | "requiresFreshSnapshot"
    | "requiresExistingScreen"
    | "requiresSingleEditableSelection"
    | "blockedByActiveMutation"
    | "requiresEditModel">
  & Partial<Pick<CanvasAgentToolProfile,
    | "requiresFreshSnapshot"
    | "requiresExistingScreen"
    | "requiresSingleEditableSelection"
    | "blockedByActiveMutation"
    | "requiresEditModel">>,
): CanvasAgentToolProfile {
  const parsed = canvasAgentToolProfileSchema.parse({
    requiresFreshSnapshot: false,
    requiresExistingScreen: false,
    requiresSingleEditableSelection: false,
    blockedByActiveMutation: false,
    requiresEditModel: false,
    ...value,
  });
  return Object.freeze({
    ...parsed,
    // The schema exposes a mutable array type; freeze the runtime value so the
    // declaration predicate remains deterministic for every caller.
    requiredCapabilities: Object.freeze([...parsed.requiredCapabilities]) as unknown as CanvasAgentToolProfile["requiredCapabilities"],
  });
}

function canvasScreenReferenceKey(reference: z.infer<typeof canvasScreenReferenceSchema>): string {
  return [
    reference.boardNodeId,
    reference.artifactId,
    reference.artifactVersionId,
    reference.screenId,
  ].join("\u0000");
}

function refineSnapshotReferences(
  references: z.infer<typeof canvasScreenReferenceSchema>[],
  field: "visibleScreens" | "selectedScreens",
  screenKeys: Set<string>,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  references.forEach((reference, index) => {
    const key = canvasScreenReferenceKey(reference);
    if (!screenKeys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index],
        message: "Canvas snapshot reference must identify a listed screen",
      });
    }
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index],
        message: "Canvas snapshot references must be unique",
      });
    }
    seen.add(key);
  });
}

function refineUniqueScreenReferences(
  references: z.infer<typeof canvasScreenReferenceSchema>[],
  path: (string | number)[],
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  references.forEach((reference, index) => {
    const key = canvasScreenReferenceKey(reference);
    if (seen.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: "Canvas screen references must be unique",
      });
    }
    seen.add(key);
  });
}

function refineUniqueScreenSummaries(
  screens: z.infer<typeof canvasScreenSummarySchema>[],
  context: z.RefinementCtx,
) {
  refineUniqueScreenReferences(screens.map((screen) => screen.reference), ["items"], context);
}

function refineUniqueStrings(
  values: readonly string[],
  path: (string | number)[],
  context: z.RefinementCtx,
) {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "Values must be unique",
    });
  }
}

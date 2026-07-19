import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";
import { artifactIrIdSchema } from "./citations.js";
import { opaqueIdSchema } from "./common.js";
import {
  prototypeActionSchema,
  prototypeAssetSchema,
  prototypeBindingSchema,
  prototypeDocumentSchema,
  prototypeMotionSchema,
  prototypeNodeSchema,
  prototypeScreenSchema,
  prototypeStateSchema,
  prototypeTokenSchema,
  prototypeVariableSchema,
  type PrototypeAction,
  type PrototypeBinding,
  type PrototypeDocument,
  type PrototypeMotion,
  type PrototypeNode,
  type PrototypeState,
} from "./prototype.js";

export const PROTOTYPE_PATCH_MAX_OPERATIONS = 128;
export const PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES = 256 * 1024;
export const PROTOTYPE_PATCH_MAX_REVISION = 2_147_483_647;

export const prototypePatchRevisionSchema = z.number().int().nonnegative().max(PROTOTYPE_PATCH_MAX_REVISION);
export const prototypePatchChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const prototypePatchCheckpointScreenSchema = z.object({
  screenId: artifactIrIdSchema,
  revision: prototypePatchRevisionSchema,
  checksum: prototypePatchChecksumSchema,
}).strict();

export const prototypeInsertNodeOperationSchema = z.object({
  kind: z.literal("insert_node"),
  parentId: artifactIrIdSchema,
  index: z.number().int().nonnegative().max(2_000),
  node: prototypeNodeSchema,
}).strict();

export const prototypeReplaceNodeOperationSchema = z.object({
  kind: z.literal("replace_node"),
  nodeId: artifactIrIdSchema,
  node: prototypeNodeSchema,
}).strict();

export const prototypeRemoveNodeOperationSchema = z.object({
  kind: z.literal("remove_node"),
  nodeId: artifactIrIdSchema,
}).strict();

export const prototypeUpdateScreenOperationSchema = z.object({
  kind: z.literal("update_screen"),
  screenId: artifactIrIdSchema,
  screen: prototypeScreenSchema,
}).strict();

export const prototypePutStateOperationSchema = z.object({
  kind: z.literal("put_state"),
  state: prototypeStateSchema,
}).strict();

export const prototypeRemoveStateOperationSchema = z.object({
  kind: z.literal("remove_state"),
  stateId: artifactIrIdSchema,
}).strict();

export const prototypePutActionOperationSchema = z.object({
  kind: z.literal("put_action"),
  action: prototypeActionSchema,
}).strict();

export const prototypeRemoveActionOperationSchema = z.object({
  kind: z.literal("remove_action"),
  actionId: artifactIrIdSchema,
}).strict();

export const prototypePutBindingOperationSchema = z.object({
  kind: z.literal("put_binding"),
  binding: prototypeBindingSchema,
}).strict();

export const prototypeRemoveBindingOperationSchema = z.object({
  kind: z.literal("remove_binding"),
  bindingId: artifactIrIdSchema,
}).strict();

export const prototypePutMotionOperationSchema = z.object({
  kind: z.literal("put_motion"),
  motion: prototypeMotionSchema,
}).strict();

export const prototypeRemoveMotionOperationSchema = z.object({
  kind: z.literal("remove_motion"),
  motionId: artifactIrIdSchema,
}).strict();

export const prototypePatchOperationSchema = z.discriminatedUnion("kind", [
  prototypeInsertNodeOperationSchema,
  prototypeReplaceNodeOperationSchema,
  prototypeRemoveNodeOperationSchema,
  prototypeUpdateScreenOperationSchema,
  prototypePutStateOperationSchema,
  prototypeRemoveStateOperationSchema,
  prototypePutActionOperationSchema,
  prototypeRemoveActionOperationSchema,
  prototypePutBindingOperationSchema,
  prototypeRemoveBindingOperationSchema,
  prototypePutMotionOperationSchema,
  prototypeRemoveMotionOperationSchema,
]);

export const prototypePatchOperationsSchema = z.array(prototypePatchOperationSchema)
  .min(1)
  .max(PROTOTYPE_PATCH_MAX_OPERATIONS);

export const prototypePatchBatchShape = {
  screenId: artifactIrIdSchema,
  baseRevision: prototypePatchRevisionSchema,
  nextRevision: prototypePatchRevisionSchema,
  operations: prototypePatchOperationsSchema,
  resultingChecksum: prototypePatchChecksumSchema,
} as const;

type PrototypePatchRevisionPair = {
  baseRevision: number;
  nextRevision: number;
};

export function prototypePatchRevisionPairIsValid(value: PrototypePatchRevisionPair): boolean {
  return value.baseRevision < PROTOTYPE_PATCH_MAX_REVISION
    && value.nextRevision === value.baseRevision + 1;
}

export function refinePrototypePatchRevisionPair(
  value: PrototypePatchRevisionPair,
  context: z.RefinementCtx,
): void {
  if (prototypePatchRevisionPairIsValid(value)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["nextRevision"],
    message: "nextRevision must equal baseRevision + 1",
  });
}

export const prototypePatchBatchSchema = z.object(prototypePatchBatchShape)
  .strict()
  .superRefine(refinePrototypePatchRevisionPair);

export const runtimePrototypePatchInputSchema = z.object({
  protocol: z.literal("workbench.runtime.prototype-patch.v1"),
  artifactIndex: z.number().int().min(0).max(19),
  ...prototypePatchBatchShape,
}).strict().superRefine(refinePrototypePatchRevisionPair);

export const prototypePatchEventPayloadSchema = z.object({
  attempt: z.number().int().positive(),
  runtimeAttemptId: opaqueIdSchema,
  artifactIndex: z.number().int().min(0).max(19),
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  sourceEventId: opaqueIdSchema,
  requestSha256: prototypePatchChecksumSchema,
  ...prototypePatchBatchShape,
}).strict().superRefine(refinePrototypePatchRevisionPair);

export const prototypePatchDegradedReasonSchema = z.enum([
  "revision_gap",
  "checksum_mismatch",
  "patch_rejected",
  "checkpoint_unavailable",
  "buffer_limit_exceeded",
]);

export const prototypePatchDegradedEventPayloadSchema = z.object({
  attempt: z.number().int().positive(),
  runtimeAttemptId: opaqueIdSchema,
  artifactIndex: z.number().int().min(0).max(19),
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  screenId: artifactIrIdSchema,
  sourceEventId: opaqueIdSchema,
  revision: prototypePatchRevisionSchema,
  reason: prototypePatchDegradedReasonSchema,
  requestSha256: prototypePatchChecksumSchema,
  baseRevision: prototypePatchRevisionSchema,
  nextRevision: prototypePatchRevisionSchema,
  operations: prototypePatchOperationsSchema,
  resultingChecksum: prototypePatchChecksumSchema,
}).strict().superRefine(refinePrototypePatchRevisionPair);

export const prototypeScreenProjectionSchema = z.object({
  protocol: z.literal("workbench.prototype-screen-projection.v1"),
  documentId: artifactIrIdSchema,
  revision: prototypePatchRevisionSchema,
  screen: prototypeScreenSchema,
  nodes: z.array(prototypeNodeSchema).min(1).max(20_000),
  tokens: z.array(prototypeTokenSchema).max(2_000),
  assets: z.array(prototypeAssetSchema).max(2_000),
  variables: z.array(prototypeVariableSchema).max(2_000),
  states: z.array(prototypeStateSchema).max(5_000),
  actions: z.array(prototypeActionSchema).max(10_000),
  bindings: z.array(prototypeBindingSchema).max(10_000),
  motions: z.array(prototypeMotionSchema).max(10_000),
}).strict();

export const prototypePatchErrorCodeSchema = z.enum([
  "INVALID_PATCH",
  "PAYLOAD_TOO_LARGE",
  "SCREEN_NOT_FOUND",
  "NODE_NOT_FOUND",
  "NODE_ALREADY_EXISTS",
  "INSERTED_NODE_CHILDREN_FORBIDDEN",
  "PARENT_NOT_FOUND",
  "PARENT_NOT_CONTAINER",
  "INDEX_OUT_OF_BOUNDS",
  "CROSS_SCREEN",
  "ROOT_NODE_REMOVE_FORBIDDEN",
  "NODE_IDENTITY_CHANGE_FORBIDDEN",
  "ENTITY_NOT_FOUND",
  "DOCUMENT_INVALID",
  "PROJECTION_INVALID",
]);

export type PrototypePatchErrorCode = z.infer<typeof prototypePatchErrorCodeSchema>;

export class PrototypePatchError extends Error {
  readonly code: PrototypePatchErrorCode;
  readonly operationIndex: number | null;

  constructor(
    code: PrototypePatchErrorCode,
    message: string,
    operationIndex: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PrototypePatchError";
    this.code = code;
    this.operationIndex = operationIndex;
  }
}

export type PrototypePatchOperation = z.infer<typeof prototypePatchOperationSchema>;
export type PrototypePatchBatch = z.infer<typeof prototypePatchBatchSchema>;
export type PrototypePatchCheckpointScreen = z.infer<typeof prototypePatchCheckpointScreenSchema>;
export type RuntimePrototypePatchInput = z.infer<typeof runtimePrototypePatchInputSchema>;
export type PrototypePatchEventPayload = z.infer<typeof prototypePatchEventPayloadSchema>;
export type PrototypePatchDegradedReason = z.infer<typeof prototypePatchDegradedReasonSchema>;
export type PrototypePatchDegradedEventPayload = z.infer<typeof prototypePatchDegradedEventPayloadSchema>;
export type PrototypeScreenProjection = z.infer<typeof prototypeScreenProjectionSchema>;

export type AppliedPrototypePatch = Readonly<{
  document: PrototypeDocument;
  projection: PrototypeScreenProjection;
  canonicalProjection: string;
}>;

export function prototypePatchCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

export function prototypePatchCanonicalByteLength(value: unknown): number {
  return utf8ByteLength(prototypePatchCanonicalJson(value));
}

export function assertPrototypePatchPayloadSize(value: unknown): number {
  const byteLength = prototypePatchCanonicalByteLength(value);
  if (byteLength > PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES) {
    throw new PrototypePatchError(
      "PAYLOAD_TOO_LARGE",
      `Prototype patch payload exceeds ${PROTOTYPE_PATCH_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return byteLength;
}

export function projectPrototypeScreen(
  input: PrototypeDocument,
  screenId: string,
  revision: number,
): PrototypeScreenProjection {
  const parsedDocument = prototypeDocumentSchema.safeParse(input);
  const parsedRevision = prototypePatchRevisionSchema.safeParse(revision);
  if (!parsedDocument.success || !parsedRevision.success) {
    throw new PrototypePatchError("PROJECTION_INVALID", "Prototype screen projection input is invalid");
  }
  const document = parsedDocument.data;
  const screen = document.screens.find((candidate) => candidate.id === screenId);
  if (!screen) throw new PrototypePatchError("SCREEN_NOT_FOUND", `Unknown screen: ${screenId}`);
  const screenNodeIds = new Set(
    document.nodes.filter((node) => node.screenId === screenId).map((node) => node.id),
  );

  return prototypeScreenProjectionSchema.parse({
    protocol: "workbench.prototype-screen-projection.v1",
    documentId: document.documentId,
    revision: parsedRevision.data,
    screen,
    nodes: sortedBy(document.nodes.filter((node) => node.screenId === screenId), (node) => node.id),
    tokens: sortedBy(document.tokens, (token) => token.id),
    assets: sortedBy(document.assets, (asset) => asset.id),
    variables: sortedBy(document.variables, (variable) => variable.path),
    states: sortedBy(document.states.filter((state) => state.screenId === screenId), (state) => state.id),
    actions: sortedBy(document.actions.filter((action) => screenNodeIds.has(action.nodeId)), (action) => action.id),
    bindings: sortedBy(document.bindings.filter((binding) => screenNodeIds.has(binding.nodeId)), (binding) => binding.id),
    motions: sortedBy(document.motions.filter((motion) => screenNodeIds.has(motion.nodeId)), (motion) => motion.id),
  });
}

export function canonicalPrototypeScreenProjection(projection: PrototypeScreenProjection): string {
  const parsed = prototypeScreenProjectionSchema.safeParse(projection);
  if (!parsed.success) {
    throw new PrototypePatchError("PROJECTION_INVALID", "Prototype screen projection is invalid");
  }
  return canonicalJson({
    ...parsed.data,
    nodes: sortedBy(parsed.data.nodes, (node) => node.id),
    tokens: sortedBy(parsed.data.tokens, (token) => token.id),
    assets: sortedBy(parsed.data.assets, (asset) => asset.id),
    variables: sortedBy(parsed.data.variables, (variable) => variable.path),
    states: sortedBy(parsed.data.states, (state) => state.id),
    actions: sortedBy(parsed.data.actions, (action) => action.id),
    bindings: sortedBy(parsed.data.bindings, (binding) => binding.id),
    motions: sortedBy(parsed.data.motions, (motion) => motion.id),
  });
}

export function computePrototypeScreenProjectionChecksum<TResult>(
  projection: PrototypeScreenProjection,
  digest: (canonicalProjection: string) => TResult,
): TResult {
  return digest(canonicalPrototypeScreenProjection(projection));
}

export function applyPrototypePatch(
  input: PrototypeDocument,
  patch: PrototypePatchBatch,
): AppliedPrototypePatch {
  const parsedDocument = prototypeDocumentSchema.safeParse(input);
  if (!parsedDocument.success) {
    throw new PrototypePatchError("DOCUMENT_INVALID", "Prototype patch base document is invalid");
  }
  const parsedPatch = prototypePatchBatchSchema.safeParse(patch);
  if (!parsedPatch.success) {
    throw new PrototypePatchError("INVALID_PATCH", "Prototype patch batch is invalid");
  }

  const batch = parsedPatch.data;
  const document = parsedDocument.data;
  if (!document.screens.some((screen) => screen.id === batch.screenId)) {
    throw new PrototypePatchError("SCREEN_NOT_FOUND", `Unknown screen: ${batch.screenId}`);
  }

  for (const [operationIndex, operation] of batch.operations.entries()) {
    applyOperation(document, batch.screenId, operation, operationIndex);
  }
  const result = prototypeDocumentSchema.safeParse(document);
  if (!result.success) {
    throw new PrototypePatchError(
      "DOCUMENT_INVALID",
      "Prototype patch batch produced an invalid document",
      null,
      { cause: result.error },
    );
  }
  const projection = projectPrototypeScreen(result.data, batch.screenId, batch.nextRevision);
  return {
    document: result.data,
    projection,
    canonicalProjection: canonicalPrototypeScreenProjection(projection),
  };
}

function applyOperation(
  document: PrototypeDocument,
  screenId: string,
  operation: PrototypePatchOperation,
  operationIndex: number,
): void {
  switch (operation.kind) {
    case "insert_node": {
      if (document.nodes.some((node) => node.id === operation.node.id)) {
        fail("NODE_ALREADY_EXISTS", `Node already exists: ${operation.node.id}`, operationIndex);
      }
      assertScreenOwner(operation.node.screenId, screenId, operationIndex);
      if (operation.node.parentId !== operation.parentId) {
        fail(
          "NODE_IDENTITY_CHANGE_FORBIDDEN",
          `Inserted node parentId must equal parentId: ${operation.node.id}`,
          operationIndex,
        );
      }
      if (childIds(operation.node).length > 0) {
        fail(
          "INSERTED_NODE_CHILDREN_FORBIDDEN",
          `Inserted container node must start without children: ${operation.node.id}`,
          operationIndex,
        );
      }
      const parent = document.nodes.find((node) => node.id === operation.parentId);
      if (!parent) fail("PARENT_NOT_FOUND", `Unknown parent node: ${operation.parentId}`, operationIndex);
      assertScreenOwner(parent.screenId, screenId, operationIndex);
      const children = mutableChildIds(parent);
      if (!children) fail("PARENT_NOT_CONTAINER", `Node cannot contain children: ${parent.id}`, operationIndex);
      if (operation.index > children.length) {
        fail("INDEX_OUT_OF_BOUNDS", `Child index is out of bounds: ${operation.index}`, operationIndex);
      }
      children.splice(operation.index, 0, operation.node.id);
      document.nodes.push(operation.node);
      return;
    }
    case "replace_node": {
      const index = document.nodes.findIndex((node) => node.id === operation.nodeId);
      if (index < 0) fail("NODE_NOT_FOUND", `Unknown node: ${operation.nodeId}`, operationIndex);
      const current = document.nodes[index]!;
      assertScreenOwner(current.screenId, screenId, operationIndex);
      assertScreenOwner(operation.node.screenId, screenId, operationIndex);
      const currentChildren = childIds(current);
      const nextChildren = childIds(operation.node);
      if (
        operation.node.id !== current.id
        || operation.node.screenId !== current.screenId
        || operation.node.parentId !== current.parentId
        || operation.node.kind !== current.kind
        || !sameStrings(currentChildren, nextChildren)
      ) {
        fail(
          "NODE_IDENTITY_CHANGE_FORBIDDEN",
          `replace_node must preserve id, screenId, parentId, kind, and childIds: ${current.id}`,
          operationIndex,
        );
      }
      document.nodes[index] = operation.node;
      return;
    }
    case "remove_node": {
      const index = document.nodes.findIndex((node) => node.id === operation.nodeId);
      if (index < 0) fail("NODE_NOT_FOUND", `Unknown node: ${operation.nodeId}`, operationIndex);
      const node = document.nodes[index]!;
      assertScreenOwner(node.screenId, screenId, operationIndex);
      const screen = document.screens.find((candidate) => candidate.id === screenId)!;
      if (screen.rootNodeId === node.id) {
        fail("ROOT_NODE_REMOVE_FORBIDDEN", `Cannot remove screen root node: ${node.id}`, operationIndex);
      }
      const parent = node.parentId === null
        ? undefined
        : document.nodes.find((candidate) => candidate.id === node.parentId);
      if (!parent) fail("PARENT_NOT_FOUND", `Unknown parent node: ${node.parentId ?? "null"}`, operationIndex);
      const children = mutableChildIds(parent);
      if (!children) fail("PARENT_NOT_CONTAINER", `Node cannot contain children: ${parent.id}`, operationIndex);
      const childIndex = children.indexOf(node.id);
      if (childIndex < 0) fail("DOCUMENT_INVALID", `Parent does not reference child: ${node.id}`, operationIndex);
      children.splice(childIndex, 1);
      document.nodes.splice(index, 1);
      return;
    }
    case "update_screen": {
      if (operation.screenId !== screenId || operation.screen.id !== operation.screenId) {
        fail("CROSS_SCREEN", "update_screen must preserve the target screen id", operationIndex);
      }
      const index = document.screens.findIndex((screen) => screen.id === operation.screenId);
      if (index < 0) fail("SCREEN_NOT_FOUND", `Unknown screen: ${operation.screenId}`, operationIndex);
      if (document.screens[index]!.rootNodeId !== operation.screen.rootNodeId) {
        fail("NODE_IDENTITY_CHANGE_FORBIDDEN", "update_screen must preserve rootNodeId", operationIndex);
      }
      document.screens[index] = operation.screen;
      return;
    }
    case "put_state":
      putState(document, screenId, operation.state, operationIndex);
      return;
    case "remove_state":
      removeState(document, screenId, operation.stateId, operationIndex);
      return;
    case "put_action":
      putNodeEntity(document, screenId, document.actions, operation.action, operationIndex);
      return;
    case "remove_action":
      removeNodeEntity(document, screenId, document.actions, operation.actionId, operationIndex);
      return;
    case "put_binding":
      putNodeEntity(document, screenId, document.bindings, operation.binding, operationIndex);
      return;
    case "remove_binding":
      removeNodeEntity(document, screenId, document.bindings, operation.bindingId, operationIndex);
      return;
    case "put_motion":
      putNodeEntity(document, screenId, document.motions, operation.motion, operationIndex);
      return;
    case "remove_motion":
      removeNodeEntity(document, screenId, document.motions, operation.motionId, operationIndex);
      return;
  }
}

function putState(
  document: PrototypeDocument,
  screenId: string,
  state: PrototypeState,
  operationIndex: number,
): void {
  assertScreenOwner(state.screenId, screenId, operationIndex);
  const index = document.states.findIndex((candidate) => candidate.id === state.id);
  if (index >= 0) {
    assertScreenOwner(document.states[index]!.screenId, screenId, operationIndex);
    document.states[index] = state;
  } else {
    document.states.push(state);
  }
}

function removeState(
  document: PrototypeDocument,
  screenId: string,
  stateId: string,
  operationIndex: number,
): void {
  const index = document.states.findIndex((state) => state.id === stateId);
  if (index < 0) fail("ENTITY_NOT_FOUND", `Unknown state: ${stateId}`, operationIndex);
  assertScreenOwner(document.states[index]!.screenId, screenId, operationIndex);
  document.states.splice(index, 1);
}

type NodeEntity = PrototypeAction | PrototypeBinding | PrototypeMotion;

function putNodeEntity<T extends NodeEntity>(
  document: PrototypeDocument,
  screenId: string,
  entities: T[],
  entity: T,
  operationIndex: number,
): void {
  assertNodeOwner(document, entity.nodeId, screenId, operationIndex);
  const index = entities.findIndex((candidate) => candidate.id === entity.id);
  if (index >= 0) {
    assertNodeOwner(document, entities[index]!.nodeId, screenId, operationIndex);
    entities[index] = entity;
  } else {
    entities.push(entity);
  }
}

function removeNodeEntity<T extends NodeEntity>(
  document: PrototypeDocument,
  screenId: string,
  entities: T[],
  entityId: string,
  operationIndex: number,
): void {
  const index = entities.findIndex((entity) => entity.id === entityId);
  if (index < 0) fail("ENTITY_NOT_FOUND", `Unknown screen entity: ${entityId}`, operationIndex);
  assertNodeOwner(document, entities[index]!.nodeId, screenId, operationIndex);
  entities.splice(index, 1);
}

function assertNodeOwner(
  document: PrototypeDocument,
  nodeId: string,
  screenId: string,
  operationIndex: number,
): void {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) fail("NODE_NOT_FOUND", `Unknown node: ${nodeId}`, operationIndex);
  assertScreenOwner(node.screenId, screenId, operationIndex);
}

function assertScreenOwner(actual: string, expected: string, operationIndex: number): void {
  if (actual !== expected) {
    fail("CROSS_SCREEN", `Entity belongs to screen ${actual}, not ${expected}`, operationIndex);
  }
}

function childIds(node: PrototypeNode): readonly string[] {
  return node.kind === "frame" || node.kind === "form" || node.kind === "button"
    ? node.childIds
    : [];
}

function mutableChildIds(node: PrototypeNode): string[] | null {
  return node.kind === "frame" || node.kind === "form" || node.kind === "button"
    ? node.childIds
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => compareStrings(key(left), key(right)));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

function fail(
  code: PrototypePatchErrorCode,
  message: string,
  operationIndex: number,
): never {
  throw new PrototypePatchError(code, message, operationIndex);
}

import { z } from "zod";
import { isoDateTimeSchema, opaqueIdSchema, revisionSchema } from "./common.js";
import { startRunRequestSchema } from "./runs.js";
const text = (max=4000) => z.string().trim().min(1).max(max);
export const requirementEvidenceSchema = z.object({
  id: opaqueIdSchema, releaseId: opaqueIdSchema, releaseVersion: z.number().int().positive(),
  documentId: opaqueIdSchema, chunkId: opaqueIdSchema, sourcePath: text(2048), title: text(240), quote: text(12000),
  scope: z.enum(["platform","template","regional","prototype","uncertain"]), checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const requirementIssueSchema = z.object({
  id: text(80), kind: z.enum(["missing","conflict","knowledge_missing","scope_expansion"]), question: text(1000),
  impact: z.enum(["scope","workflow","permission","financial","external_dependency","platform","presentation"]),
  blocking: z.boolean(), evidenceIds: z.array(opaqueIdSchema).max(20),
}).strict();
export const requirementAssumptionSchema = z.object({id:text(80),text:text(2000),evidenceIds:z.array(opaqueIdSchema).max(20)}).strict();
export const requirementCardSchema = z.object({
  goal:text(), platform:text(240), modules:z.array(text(240)).min(1).max(30), roles:z.array(text(240)).min(1).max(30),
  existingCapabilities:z.array(z.object({description:text(2000),evidenceIds:z.array(opaqueIdSchema).min(1).max(20),scope:z.enum(["platform","template","regional","prototype","uncertain"])}).strict()).max(50),
  reuse:z.array(text(2000)).max(50), changes:z.array(text(2000)).min(1).max(50),
  affectedPages:z.array(text(500)).max(50), affectedFlows:z.array(text(2000)).max(30),
  targetSurface:z.enum(["app","web"]),designConstraints:z.array(text(2000)).max(30),
  outputKinds:z.array(z.enum(["prd","prototype"])).min(1).max(2).refine(xs=>new Set(xs).size===xs.length),
  assumptions:z.array(requirementAssumptionSchema).max(30),issues:z.array(requirementIssueSchema).max(20),
  platformChanges:z.array(text(2000)).max(20), preserved:z.array(text(2000)).max(50),
}).strict();
export const requirementAnalysisSchema = z.object({reply:text(12000),card:requirementCardSchema}).strict();
export const requirementTurnSchema = z.object({
  id:opaqueIdSchema,sessionId:opaqueIdSchema,inputRevision:revisionSchema,
  status:z.enum(["queued","running","succeeded","failed","cancelled","superseded"]),
  modelId:z.literal("deepseek-flash"),attempt:z.number().int().nonnegative(),
  failureCode:z.string().nullable(),inputTokens:z.number().int().nonnegative().nullable(),outputTokens:z.number().int().nonnegative().nullable(),
  createdAt:isoDateTimeSchema,finishedAt:isoDateTimeSchema.nullable(),
}).strict();
export const requirementConfirmationSchema = z.object({
  id:opaqueIdSchema,summaryVersion:z.number().int().positive(),summaryChecksum:z.string().regex(/^[a-f0-9]{64}$/),
  status:z.enum(["pending","started","invalidated"]),acceptedAssumptionIds:z.array(text(80)).max(30),
  acceptedPlatformChanges:z.boolean(),confirmedAt:isoDateTimeSchema,planId:opaqueIdSchema.nullable(),runId:opaqueIdSchema.nullable(),
}).strict();
export const requirementSessionSchema = z.object({
  id:opaqueIdSchema,projectId:opaqueIdSchema,threadId:opaqueIdSchema,revision:revisionSchema,
  state:z.enum(["discussing","analyzing","needs_clarification","ready_to_confirm","confirmed","generating"]),
  generationRequest:startRunRequestSchema,summaryVersion:z.number().int().nonnegative(),summaryChecksum:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  card:requirementCardSchema.nullable(),evidence:z.array(requirementEvidenceSchema).max(30),
  activeTurn:requirementTurnSchema.nullable(),confirmation:requirementConfirmationSchema.nullable(),
  createdAt:isoDateTimeSchema,updatedAt:isoDateTimeSchema,
}).strict();
export const createRequirementSessionRequestSchema=z.object({generationRequest:startRunRequestSchema}).strict();
export const postRequirementMessageRequestSchema=z.object({text:text(12000),generationRequest:startRunRequestSchema.optional(),intent:z.enum(["discuss","confirm_suggestion"]).default("discuss")}).strict();
export const confirmRequirementRequestSchema=z.object({summaryVersion:z.number().int().positive(),summaryChecksum:z.string().regex(/^[a-f0-9]{64}$/),acceptedAssumptionIds:z.array(text(80)).max(30),acceptedPlatformChanges:z.boolean()}).strict();
export const requirementSessionsSchema=z.object({items:z.array(requirementSessionSchema).max(100)}).strict();
export type RequirementCard=z.infer<typeof requirementCardSchema>;
export type RequirementEvidence=z.infer<typeof requirementEvidenceSchema>;
export type RequirementAnalysis=z.infer<typeof requirementAnalysisSchema>;
export type RequirementSession=z.infer<typeof requirementSessionSchema>;
export type PostRequirementMessageRequest=z.infer<typeof postRequirementMessageRequestSchema>;
export type ConfirmRequirementRequest=z.infer<typeof confirmRequirementRequestSchema>;

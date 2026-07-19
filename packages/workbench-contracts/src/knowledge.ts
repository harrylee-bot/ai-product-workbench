import { z } from "zod";
import { artifactCitationSchema } from "./citations.js";
import { isoDateTimeSchema, jsonValueSchema, opaqueIdSchema } from "./common.js";

export const knowledgeProfileKindSchema = z.enum(["embedding", "retrieval"]);
export const knowledgeProfileStatusSchema = z.enum(["candidate", "poc", "adopted", "retired"]);
export const knowledgeProfileScopeSchema = z.literal("global");
export const knowledgeProfileIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

const knowledgeProfileBaseShape = {
  id: knowledgeProfileIdSchema,
  profileVersion: z.literal(1),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  status: knowledgeProfileStatusSchema,
  scope: knowledgeProfileScopeSchema,
  spec: z.record(jsonValueSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const embeddingKnowledgeProfileSchema = z.object({
  ...knowledgeProfileBaseShape,
  kind: z.literal("embedding"),
  dimension: z.number().int().positive().max(16_000),
}).strict();

export const retrievalKnowledgeProfileSchema = z.object({
  ...knowledgeProfileBaseShape,
  kind: z.literal("retrieval"),
  embedding: z.object({
    profileId: knowledgeProfileIdSchema,
    profileSpecSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    dimension: z.number().int().positive().max(16_000),
  }).strict(),
}).strict();

export const knowledgeProfileSchema = z.discriminatedUnion("kind", [
  embeddingKnowledgeProfileSchema,
  retrievalKnowledgeProfileSchema,
]);

export const createKnowledgeProfileRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("embedding"), spec: z.record(jsonValueSchema) }).strict(),
  z.object({ kind: z.literal("retrieval"), spec: z.record(jsonValueSchema) }).strict(),
]);

export const promoteKnowledgeProfileRequestSchema = z.discriminatedUnion("targetStatus", [
  z.object({ expectedStatus: z.literal("candidate"), targetStatus: z.literal("poc") }).strict(),
  z.object({ expectedStatus: z.literal("poc"), targetStatus: z.literal("adopted") }).strict(),
]);

export const retireKnowledgeProfileRequestSchema = z.object({
  expectedStatus: z.enum(["candidate", "poc", "adopted"]),
}).strict();

export const knowledgeProfileAdoptionReceiptSchema = z.object({
  id: opaqueIdSchema,
  profileKind: knowledgeProfileKindSchema,
  profileId: knowledgeProfileIdSchema,
  profileVersion: z.literal(1),
  profileSpecSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  actorPrincipalId: opaqueIdSchema,
  scope: knowledgeProfileScopeSchema,
  adoptedAt: isoDateTimeSchema,
}).strict();

const pocKnowledgeProfileSchema = z.discriminatedUnion("kind", [
  embeddingKnowledgeProfileSchema.extend({ status: z.literal("poc") }).strict(),
  retrievalKnowledgeProfileSchema.extend({ status: z.literal("poc") }).strict(),
]);

const adoptedKnowledgeProfileSchema = z.discriminatedUnion("kind", [
  embeddingKnowledgeProfileSchema.extend({ status: z.literal("adopted") }).strict(),
  retrievalKnowledgeProfileSchema.extend({ status: z.literal("adopted") }).strict(),
]);

export const knowledgeProfilePromotionResultSchema = z.union([
  z.object({ profile: pocKnowledgeProfileSchema, adoptionReceipt: z.null() }).strict(),
  z.object({
    profile: adoptedKnowledgeProfileSchema,
    adoptionReceipt: knowledgeProfileAdoptionReceiptSchema,
  }).strict(),
]);

export const knowledgeProfileListSchema = z.object({
  items: z.array(knowledgeProfileSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();

export const knowledgeProfileAdoptionReceiptListSchema = z.object({
  items: z.array(knowledgeProfileAdoptionReceiptSchema).max(100),
  nextCursor: z.string().nullable(),
}).strict();

export const knowledgeRetrievalModeSchema = z.literal("hybrid");
export const knowledgeRetrievalRouteScopeSchema = z.literal("production");

export const knowledgeToolRequestSchema = z.object({
  protocol: z.literal("workbench.knowledge-retrieval-request.v1"),
  query: z.string().trim().min(1).max(4_000),
}).strict();

const knowledgeReleaseEvidenceSchema = z.object({
  id: opaqueIdSchema,
  key: z.string().min(1).max(240),
  version: z.number().int().positive(),
}).strict();

const embeddingProfileEvidenceSchema = z.object({
  id: z.string().min(1).max(200),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dimension: z.number().int().positive(),
}).strict();

const retrievalProfileEvidenceSchema = z.object({
  id: z.string().min(1).max(128),
  specSha256: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const rerankerIdentitySchema = z.object({
  id: z.string().min(1).max(240),
  revision: z.string().min(1).max(240),
}).strict();

export const knowledgeRetrievalEvidenceSchema = z.object({
  schema: z.literal("workbench.knowledge-retrieval-evidence.v1"),
  mode: knowledgeRetrievalModeSchema,
  routeScope: knowledgeRetrievalRouteScopeSchema,
  release: knowledgeReleaseEvidenceSchema,
  embeddingProfile: embeddingProfileEvidenceSchema,
  retrievalProfile: retrievalProfileEvidenceSchema,
  candidateCounts: z.object({
    lexical: z.number().int().nonnegative(),
    dense: z.number().int().nonnegative(),
    fused: z.number().int().nonnegative(),
  }).strict(),
  fusion: z.object({ algorithm: z.literal("rrf"), k: z.number().int().positive() }).strict(),
  reranker: z.discriminatedUnion("status", [
    z.object({ status: z.literal("not_requested") }).strict(),
    z.object({ status: z.literal("not_needed") }).strict(),
    rerankerIdentitySchema.extend({ status: z.literal("applied") }).strict(),
    rerankerIdentitySchema.extend({
      status: z.literal("degraded"),
      reason: z.enum(["RERANKER_REQUEST_FAILED", "RERANKER_OUTPUT_INVALID"]),
    }).strict(),
  ]),
  degraded: z.boolean(),
}).strict();

export const knowledgeRetrievalItemSchema = z.object({
  rank: z.number().int().positive(),
  rrfScore: z.number().finite().nonnegative(),
  rerankerScore: z.number().finite().nullable(),
  citation: artifactCitationSchema,
}).strict();

export const knowledgeToolResponseSchema = z.object({
  protocol: z.literal("workbench.knowledge-retrieval-result.v1"),
  evidence: knowledgeRetrievalEvidenceSchema,
  items: z.array(knowledgeRetrievalItemSchema).max(12),
}).strict().superRefine((result, context) => {
  const citationIds = new Set<string>();
  result.items.forEach((item, index) => {
    if (item.rank !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "rank"],
        message: "Knowledge retrieval ranks must be contiguous and ordered",
      });
    }
    if (citationIds.has(item.citation.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items", index, "citation", "id"],
        message: "Knowledge retrieval citation ids must be unique",
      });
    }
    citationIds.add(item.citation.id);
  });
});

export const knowledgeToolDescriptorSchema = z.object({
  protocol: z.literal("workbench.knowledge-tool.v1"),
  endpoint: z.string().url().max(2_048).superRefine((value, context) => {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Knowledge tool endpoint must be a safe HTTP(S) URL" });
    }
  }),
  token: z.string().min(64).max(4_096).regex(/^wbkg1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u),
  expiresAt: isoDateTimeSchema,
  releaseId: opaqueIdSchema,
  mode: knowledgeRetrievalModeSchema,
  routeScope: knowledgeRetrievalRouteScopeSchema,
}).strict();

export const knowledgeToolReferenceSchema = z.object({
  protocol: z.literal("workbench.knowledge-tool-reference.v1"),
  toolName: z.literal("workbench_knowledge_retrieve"),
  releaseId: opaqueIdSchema,
  mode: knowledgeRetrievalModeSchema,
  routeScope: knowledgeRetrievalRouteScopeSchema,
}).strict();

export type KnowledgeToolRequest = z.infer<typeof knowledgeToolRequestSchema>;
export type KnowledgeProfileKind = z.infer<typeof knowledgeProfileKindSchema>;
export type KnowledgeProfileStatus = z.infer<typeof knowledgeProfileStatusSchema>;
export type KnowledgeProfile = z.infer<typeof knowledgeProfileSchema>;
export type CreateKnowledgeProfileRequest = z.infer<typeof createKnowledgeProfileRequestSchema>;
export type PromoteKnowledgeProfileRequest = z.infer<typeof promoteKnowledgeProfileRequestSchema>;
export type RetireKnowledgeProfileRequest = z.infer<typeof retireKnowledgeProfileRequestSchema>;
export type KnowledgeProfileAdoptionReceipt = z.infer<typeof knowledgeProfileAdoptionReceiptSchema>;
export type KnowledgeProfilePromotionResult = z.infer<typeof knowledgeProfilePromotionResultSchema>;
export type KnowledgeProfileList = z.infer<typeof knowledgeProfileListSchema>;
export type KnowledgeProfileAdoptionReceiptList = z.infer<typeof knowledgeProfileAdoptionReceiptListSchema>;
export type KnowledgeRetrievalEvidence = z.infer<typeof knowledgeRetrievalEvidenceSchema>;
export type KnowledgeRetrievalItem = z.infer<typeof knowledgeRetrievalItemSchema>;
export type KnowledgeToolResponse = z.infer<typeof knowledgeToolResponseSchema>;
export type KnowledgeToolDescriptor = z.infer<typeof knowledgeToolDescriptorSchema>;
export type KnowledgeToolReference = z.infer<typeof knowledgeToolReferenceSchema>;

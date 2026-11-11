import { z, type ZodTypeAny } from "zod";
import { artifactFinalizationStateSchema, confirmArtifactFinalizationRequestSchema } from "./finalizations.js";
import {
  artifactKindSchema,
  artifactCreationSchema,
  artifactListSchema,
  artifactSchema,
  artifactVersionFavoriteListSchema,
  artifactVersionPreferenceSchema,
  artifactVersionPreferenceTargetQuerySchema,
  createArtifactRequestSchema,
  createArtifactVersionRequestSchema,
  publicArtifactVersionDetailSchema,
  artifactVersionDetailSchema,
  artifactVersionListSchema,
  updateArtifactVersionPreferenceRequestSchema,
} from "./artifacts.js";
import { boardSchema, replaceBoardRequestSchema } from "./boards.js";
import {
  canvasAgentToolInvocationSchema,
  canvasAgentToolResultSchema,
  canvasClientCommandAckRequestSchema,
  canvasClientCommandAckSchema,
  canvasClientCommandListSchema,
  canvasClientStateSyncRequestSchema,
  canvasClientStateSyncResponseSchema,
} from "./canvas-agent-tools.js";
import { projectBootstrapSchema } from "./bootstrap.js";
import { designPresetCatalogSchema } from "./design-presets.js";
import {
  createDesignSystemRequestSchema,
  designSystemCatalogSchema,
  designSystemCreationSchema,
  designSystemImportSchema,
  importDesignSystemRequestSchema,
} from "./design-systems.js";
import {
  completeFileUploadRequestSchema,
  completeFileUploadResponseSchema,
  createFileUploadRequestSchema,
  createFileUploadResponseSchema,
  fileAssetSchema,
  fileExtractionSchema,
  fileListSchema,
  fileStatusSchema,
  fileUploadSessionSchema,
  listUploadPartsResponseSchema,
  signUploadPartRequestSchema,
  signUploadPartResponseSchema,
} from "./files.js";
import {
  createProjectRequestSchema,
  duplicateProjectRequestSchema,
  projectDuplicateSchema,
  projectListSchema,
  projectMemberListSchema,
  projectMemberSchema,
  projectRelationshipSchema,
  projectSchema,
  setProjectMemberRoleRequestSchema,
  updateProjectRequestSchema,
} from "./projects.js";
import {
  createProjectRemixRequestSchema,
  createProjectRemixResponseSchema,
} from "./remixes.js";
import {
  createProjectReleaseRequestSchema,
  projectReleaseListSchema,
  projectReleaseSchema,
} from "./releases.js";
import {
  runApprovalListSchema,
  runApprovalSchema,
  runListSchema,
  runPrototypePatchCheckpointQuerySchema,
  runPrototypePatchCheckpointSchema,
  runSchema,
  submitApprovalRequestSchema,
  submitApprovalResponseSchema,
} from "./runs.js";
import { runtimeModelListSchema } from "./runtime-models.js";
import { healthSchema, principalSchema } from "./system.js";
import {
  publicShareSchema,
  revokeProjectShareGrantsResponseSchema,
  rotateShareGrantRequestSchema,
  rotateShareGrantResponseSchema,
  shareGrantListSchema,
  shareGrantSchema,
} from "./shares.js";
import {
  createExternalExportDeliveryRequestSchema,
  createExportJobRequestSchema,
  externalExportDeliveryListSchema,
  externalExportDeliverySchema,
  exportCapabilitiesSchema,
  exportJobListSchema,
  exportJobSchema,
  exportPreviewTokenResponseSchema,
} from "./exports.js";
import {
  createProjectPreviewRequestSchema,
  previewTokenResponseSchema,
  projectPreviewSchema,
} from "./previews.js";
import {
  createThreadRequestSchema,
  threadEntryListSchema,
  threadListSchema,
  threadSchema,
  updateThreadRequestSchema,
} from "./threads.js";
import {
  communicationPreferencesSchema,
  updateCommunicationPreferencesRequestSchema,
} from "./identity.js";
import {
  createKnowledgeProfileRequestSchema,
  knowledgeProfileAdoptionReceiptListSchema,
  knowledgeProfileKindSchema,
  knowledgeProfileListSchema,
  knowledgeProfilePromotionResultSchema,
  knowledgeProfileSchema,
  knowledgeProfileStatusSchema,
  knowledgeToolRequestSchema,
  knowledgeToolResponseSchema,
  promoteKnowledgeProfileRequestSchema,
  retireKnowledgeProfileRequestSchema,
} from "./knowledge.js";
import {
  acceptProjectInvitationResponseSchema,
  createProjectInvitationRequestSchema,
  createProjectInvitationResponseSchema,
  projectInvitationListSchema,
  projectInvitationPreviewSchema,
  projectInvitationStatusSchema,
  projectInvitationSchema,
  projectInvitationTokenRequestSchema,
} from "./invitations.js";
import { workspaceMemberListSchema } from "./workspaces.js";
import {
  createImportSourceRequestSchema,
  importSourceListSchema,
  importSourceSchema,
} from "./import-sources.js";
import {
  createSubmissionIntentRequestSchema,
  currentSubmissionIntentSchema,
  submissionIntentSchema,
  submitSubmissionIntentResponseSchema,
} from "./submission-intents.js";

export type WorkbenchHttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type WorkbenchRequestHeader = "byteRange" | "idempotencyKey" | "ifMatch" | "ifNoneMatch" | "lastEventId";
export type WorkbenchResponseHeader =
  | "contentDisposition"
  | "contentDigestEtag"
  | "etag"
  | "fileRevisionEtag"
  | "canvasVisualSha256"
  | "canvasVisualExpiresAt"
  | "location"
  | "uploadRevisionEtag";

export type NamedWorkbenchSchema = Readonly<{
  name: string;
  schema: ZodTypeAny;
}>;

export type WorkbenchRouteResponse = Readonly<{
  status: number;
  description: string;
  schema?: NamedWorkbenchSchema;
  mediaType?: "application/json" | "application/octet-stream" | "text/event-stream";
  headers?: readonly WorkbenchResponseHeader[];
  byteRange?: "complete" | "partial";
}>;

export type WorkbenchHttpRoute = Readonly<{
  method: WorkbenchHttpMethod;
  path: string;
  operationId: string;
  public?: boolean;
  capability?: "knowledgeGrant" | "canvasGrant";
  query?: z.ZodObject;
  requestHeaders?: readonly WorkbenchRequestHeader[];
  requestBody?: NamedWorkbenchSchema;
  response: WorkbenchRouteResponse;
  additionalResponses?: readonly WorkbenchRouteResponse[];
  problemStatuses?: readonly number[];
  rangeProblem?: boolean;
}>;

const named = (name: string, schema: ZodTypeAny): NamedWorkbenchSchema => ({ name, schema });
const response = (
  status: number,
  description: string,
  schema?: NamedWorkbenchSchema,
  headers?: readonly WorkbenchResponseHeader[],
): WorkbenchRouteResponse => ({ status, description, schema, headers });
const problems = (...statuses: number[]) => statuses;

const cursorPageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict();

const projectPageQuery = cursorPageQuery.extend({
  q: z.string().trim().min(1).max(160).optional()
    .describe("Case-insensitive title and summary search bound to the cursor"),
  relationship: projectRelationshipSchema.optional()
    .describe("Filter owned Projects (owner role) or Projects shared as editor/viewer"),
}).strict();

const designSystemCatalogPageQuery = cursorPageQuery.extend({
  q: z.string().trim().min(1).max(160).optional()
    .describe("Case-insensitive Design System or source Project title search bound to the cursor"),
}).strict();

const workspaceMemberPageQuery = cursorPageQuery.extend({
  cursor: z.string().min(1).max(2_048).optional(),
  q: z.string().trim().min(1).max(160).optional()
    .describe("Case-insensitive display name or email search bound to the cursor"),
}).strict();

const projectInvitationPageQuery = cursorPageQuery.extend({
  cursor: z.string().min(1).max(2_048).optional(),
  status: projectInvitationStatusSchema.optional()
    .describe("Invitation lifecycle status bound to the cursor"),
}).strict();

const knowledgeProfilePageQuery = cursorPageQuery.extend({
  kind: knowledgeProfileKindSchema,
  status: knowledgeProfileStatusSchema.optional(),
}).strict();

const knowledgeProfileAdoptionReceiptPageQuery = cursorPageQuery.extend({
  kind: knowledgeProfileKindSchema.optional(),
  profileId: z.string().min(1).max(128).optional(),
}).strict();

const canvasClientCommandPageQuery = z.object({
  clientSessionId: z.string().min(8).max(128),
  projectSessionGeneration: z.number().int().positive(),
  after: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();

export const workbenchHttpRoutes = [
  {
    method: "get", path: "/system/live", operationId: "getLiveness", public: true,
    response: response(200, "Process is alive", named("Health", healthSchema)),
  },
  {
    method: "get", path: "/system/ready", operationId: "getReadiness", public: true,
    response: response(200, "Required infrastructure is ready", named("Health", healthSchema)),
    problemStatuses: problems(503),
  },
  {
    method: "get", path: "/identity/me", operationId: "getCurrentPrincipal",
    response: response(200, "Current principal and default workspace", named("Principal", principalSchema)),
    problemStatuses: problems(401),
  },
  {
    method: "get", path: "/identity/preferences", operationId: "getCommunicationPreferences",
    response: response(200, "Current principal communication preferences", named("CommunicationPreferences", communicationPreferencesSchema), ["etag"]),
    problemStatuses: problems(401),
  },
  {
    method: "put", path: "/identity/preferences", operationId: "updateCommunicationPreferences",
    requestHeaders: ["ifMatch"], requestBody: named("UpdateCommunicationPreferencesRequest", updateCommunicationPreferencesRequestSchema),
    response: response(200, "Current principal communication preferences updated with compare-and-swap", named("CommunicationPreferences", communicationPreferencesSchema), ["etag"]),
    problemStatuses: problems(400, 401, 412, 428),
  },
  {
    method: "get", path: "/runtime/models", operationId: "listRuntimeModels",
    response: response(200, "Runtime models currently available through DeerFlow", named("RuntimeModelList", runtimeModelListSchema)),
    problemStatuses: problems(401, 502, 504),
  },
  {
    method: "get", path: "/design-presets", operationId: "listDesignPresets",
    response: response(200, "Authoritative immutable Design preset catalog", named("DesignPresetCatalog", designPresetCatalogSchema)),
    problemStatuses: problems(401),
  },
  {
    method: "get", path: "/knowledge/profiles", operationId: "listKnowledgeProfiles",
    query: knowledgeProfilePageQuery,
    response: response(200, "Cursor page of immutable Knowledge Profiles visible only to authorized Profile operators", named("KnowledgeProfileList", knowledgeProfileListSchema)),
    problemStatuses: problems(400, 401, 403),
  },
  {
    method: "post", path: "/knowledge/profiles", operationId: "createKnowledgeProfile",
    requestBody: named("CreateKnowledgeProfileRequest", createKnowledgeProfileRequestSchema),
    response: response(201, "Canonical candidate Knowledge Profile created by an authorized Profile operator; kind, profile id, and canonical spec SHA-256 form its natural idempotency key", named("KnowledgeProfile", knowledgeProfileSchema), ["location"]),
    problemStatuses: problems(400, 401, 403, 409),
  },
  {
    method: "get", path: "/knowledge/profiles/{profileType}/{profileId}", operationId: "getKnowledgeProfile",
    response: response(200, "Immutable Knowledge Profile and current governed lifecycle status", named("KnowledgeProfile", knowledgeProfileSchema)),
    problemStatuses: problems(400, 401, 403, 404),
  },
  {
    method: "post", path: "/knowledge/profiles/{profileType}/{profileId}/promote", operationId: "promoteKnowledgeProfile",
    requestBody: named("PromoteKnowledgeProfileRequest", promoteKnowledgeProfileRequestSchema),
    response: response(200, "Knowledge Profile atomically promoted by one lifecycle step; adoption returns its immutable receipt", named("KnowledgeProfilePromotionResult", knowledgeProfilePromotionResultSchema)),
    problemStatuses: problems(400, 401, 403, 404, 409),
  },
  {
    method: "post", path: "/knowledge/profiles/{profileType}/{profileId}/retire", operationId: "retireKnowledgeProfile",
    requestBody: named("RetireKnowledgeProfileRequest", retireKnowledgeProfileRequestSchema),
    response: response(200, "Knowledge Profile retired with a locked expected-state transition", named("KnowledgeProfile", knowledgeProfileSchema)),
    problemStatuses: problems(400, 401, 403, 404, 409),
  },
  {
    method: "get", path: "/knowledge/profile-adoption-receipts", operationId: "listKnowledgeProfileAdoptionReceipts",
    query: knowledgeProfileAdoptionReceiptPageQuery,
    response: response(200, "Cursor page of immutable global Knowledge Profile adoption receipts", named("KnowledgeProfileAdoptionReceiptList", knowledgeProfileAdoptionReceiptListSchema)),
    problemStatuses: problems(400, 401, 403),
  },
  {
    method: "post", path: "/runtime/knowledge/retrieve", operationId: "retrieveRuntimeKnowledge",
    capability: "knowledgeGrant", requestHeaders: ["idempotencyKey"], requestBody: named("KnowledgeToolRequest", knowledgeToolRequestSchema),
    response: response(200, "Citation-ready Knowledge results scoped to one authorized Run and pinned release", named("KnowledgeToolResponse", knowledgeToolResponseSchema)),
    problemStatuses: problems(400, 401, 404, 409, 429, 502, 503, 504),
  },
  {
    method: "post", path: "/runtime/canvas/tools/execute", operationId: "executeRuntimeCanvasTool",
    capability: "canvasGrant", requestHeaders: ["idempotencyKey"], requestBody: named("CanvasAgentToolInvocation", canvasAgentToolInvocationSchema),
    response: response(200, "Canvas tool result or durable wait state scoped to one Agent session and toolCallId", named("CanvasAgentToolResult", canvasAgentToolResultSchema)),
    problemStatuses: problems(400, 401, 403, 404, 409, 412, 503),
  },
  {
    method: "get", path: "/runtime/canvas/visuals/{visualCapabilityId}", operationId: "getRuntimeCanvasVisual",
    capability: "canvasGrant", requestHeaders: ["ifNoneMatch"],
    response: {
      status: 200,
      description: "Verified, short-lived Canvas visual capture bound to one Canvas grant",
      mediaType: "application/octet-stream",
      headers: ["contentDigestEtag", "canvasVisualSha256", "canvasVisualExpiresAt"],
    },
    additionalResponses: [response(304, "Canvas visual capture digest matches If-None-Match")],
    problemStatuses: problems(401, 404, 503),
  },
  {
    method: "put", path: "/projects/{projectId}/canvas-agent/state", operationId: "syncCanvasAgentClientState",
    requestBody: named("CanvasClientStateSyncRequest", canvasClientStateSyncRequestSchema),
    response: response(200, "Current browser-owned Canvas selection and viewport synchronized to the active Agent session", named("CanvasClientStateSyncResponse", canvasClientStateSyncResponseSchema)),
    problemStatuses: problems(400, 401, 404, 409, 412),
  },
  {
    method: "get", path: "/projects/{projectId}/canvas-agent/commands", operationId: "listCanvasAgentClientCommands",
    query: canvasClientCommandPageQuery,
    response: response(200, "Pending Canvas client commands scoped to the authenticated Product workspace session", named("CanvasClientCommandList", canvasClientCommandListSchema)),
    problemStatuses: problems(400, 401, 404),
  },
  {
    method: "post", path: "/projects/{projectId}/canvas-agent/commands/{commandId}/ack", operationId: "acknowledgeCanvasAgentClientCommand",
    requestBody: named("CanvasClientCommandAckRequest", canvasClientCommandAckRequestSchema),
    response: response(200, "Durable acknowledgement for a scoped Canvas client command", named("CanvasClientCommandAck", canvasClientCommandAckSchema)),
    problemStatuses: problems(400, 401, 404, 409, 412),
  },
  {
    method: "get", path: "/workspaces/{workspaceId}/members", operationId: "listWorkspaceMembers",
    query: workspaceMemberPageQuery,
    response: response(200, "Cursor page of Workspace members visible to Workspace members", named("WorkspaceMemberList", workspaceMemberListSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "get", path: "/projects", operationId: "listProjects",
    query: projectPageQuery,
    response: response(200, "Cursor page of active Projects across every Workspace where the principal is an explicit member", named("ProjectList", projectListSchema)),
    problemStatuses: problems(400),
  },
  {
    method: "post", path: "/workspaces/{workspaceId}/projects", operationId: "createProject",
    requestBody: named("CreateProjectRequest", createProjectRequestSchema),
    response: response(201, "Project created with a default Thread and Board", named("Project", projectSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404),
  },
  {
    method: "patch", path: "/projects/{projectId}", operationId: "updateProject",
    requestHeaders: ["ifMatch"], requestBody: named("UpdateProjectRequest", updateProjectRequestSchema),
    response: response(200, "Project updated", named("Project", projectSchema), ["etag"]),
    problemStatuses: problems(400, 404, 412, 428),
  },
  {
    method: "delete", path: "/projects/{projectId}", operationId: "archiveProject",
    requestHeaders: ["ifMatch"],
    response: response(200, "Project soft-archived; active public Share grants are revoked", named("Project", projectSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "post", path: "/projects/{projectId}/duplicate", operationId: "duplicateProject",
    requestHeaders: ["idempotencyKey"], requestBody: named("DuplicateProjectRequest", duplicateProjectRequestSchema),
    response: response(201, "Private Project snapshot duplicated in the same Workspace without source Thread history or entries, Runs, Files, Releases, Shares, or Exports", named("ProjectDuplicate", projectDuplicateSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/projects/{projectId}/members", operationId: "listProjectMembers",
    response: response(200, "Explicit Project members and roles", named("ProjectMemberList", projectMemberListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "put", path: "/projects/{projectId}/members/{principalId}", operationId: "setProjectMemberRole",
    requestHeaders: ["ifMatch"], requestBody: named("SetProjectMemberRoleRequest", setProjectMemberRoleRequestSchema),
    response: response(200, "Project member added or assigned a role by an owner", named("ProjectMember", projectMemberSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "delete", path: "/projects/{projectId}/members/{principalId}", operationId: "removeProjectMember",
    requestHeaders: ["ifMatch"],
    response: response(204, "Project member removed by an owner", undefined, ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/projects/{projectId}/invitations", operationId: "listProjectInvitations",
    query: projectInvitationPageQuery,
    response: response(200, "Cursor page of Project invitations visible to Project owners", named("ProjectInvitationList", projectInvitationListSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "post", path: "/projects/{projectId}/invitations", operationId: "createProjectInvitation",
    requestHeaders: ["ifMatch", "idempotencyKey"], requestBody: named("CreateProjectInvitationRequest", createProjectInvitationRequestSchema),
    response: response(201, "External Project invitation created with a manually deliverable acceptance token", named("CreateProjectInvitationResponse", createProjectInvitationResponseSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "delete", path: "/projects/{projectId}/invitations/{invitationId}", operationId: "revokeProjectInvitation",
    requestHeaders: ["ifMatch"],
    response: response(200, "Pending Project invitation revoked by a Project owner", named("ProjectInvitation", projectInvitationSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "post", path: "/project-invitations/preview", operationId: "previewProjectInvitation",
    requestBody: named("ProjectInvitationTokenRequest", projectInvitationTokenRequestSchema),
    response: response(200, "Invitation preview available only to the authenticated matching email", named("ProjectInvitationPreview", projectInvitationPreviewSchema)),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "post", path: "/project-invitations/accept", operationId: "acceptProjectInvitation",
    requestBody: named("ProjectInvitationTokenRequest", projectInvitationTokenRequestSchema),
    response: response(200, "Invitation accepted atomically into its Workspace and Project", named("AcceptProjectInvitationResponse", acceptProjectInvitationResponseSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/projects/{projectId}/bootstrap", operationId: "getProjectBootstrap",
    query: z.object({
      threadId: z.string().min(1).max(128)
        .describe("Thread to select for entries and latest Run recovery")
        .optional(),
    }).strict(),
    response: response(200, "Atomic workspace bootstrap projection", named("ProjectBootstrap", projectBootstrapSchema), ["etag"]),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/projects/{projectId}/threads", operationId: "listThreads",
    query: cursorPageQuery,
    response: response(200, "Active Threads ordered by latest activity", named("ThreadList", threadListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/threads", operationId: "createThread",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateThreadRequest", createThreadRequestSchema),
    response: response(201, "Thread created", named("Thread", threadSchema), ["etag", "location"]),
    problemStatuses: problems(409),
  },
  {
    method: "get", path: "/threads/{threadId}", operationId: "getThread",
    response: response(200, "Thread snapshot", named("Thread", threadSchema), ["etag"]),
    problemStatuses: problems(404),
  },
  {
    method: "patch", path: "/threads/{threadId}", operationId: "updateThread",
    requestHeaders: ["ifMatch"], requestBody: named("UpdateThreadRequest", updateThreadRequestSchema),
    response: response(200, "Thread updated with compare-and-swap", named("Thread", threadSchema), ["etag"]),
    problemStatuses: problems(400, 404, 412, 428),
  },
  {
    method: "delete", path: "/threads/{threadId}", operationId: "archiveThread",
    requestHeaders: ["ifMatch"], response: response(204, "Thread archived"),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/threads/{threadId}/entries", operationId: "listThreadEntries",
    query: z.object({
      afterSequence: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }).strict(),
    response: response(200, "Immutable Thread entries ordered by sequence", named("ThreadEntryList", threadEntryListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/projects/{projectId}/board", operationId: "getBoard",
    response: response(200, "Current Board", named("Board", boardSchema), ["etag"]),
  },
  {
    method: "get", path: "/projects/{projectId}/releases", operationId: "listProjectReleases",
    query: cursorPageQuery,
    response: response(200, "Immutable Project releases ordered newest first", named("ProjectReleaseList", projectReleaseListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/releases", operationId: "createProjectRelease",
    requestHeaders: ["ifMatch", "idempotencyKey"], requestBody: named("CreateProjectReleaseRequest", createProjectReleaseRequestSchema),
    response: response(201, "Immutable Project release created from the exact Board revision", named("ProjectRelease", projectReleaseSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/releases/{releaseId}", operationId: "getProjectRelease",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Immutable Project release", named("ProjectRelease", projectReleaseSchema), ["etag"]),
    additionalResponses: [response(304, "Release manifest digest matches If-None-Match")],
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/projects/{projectId}/shares", operationId: "listShareGrants",
    query: cursorPageQuery,
    response: response(200, "Share grants for immutable Project releases", named("ShareGrantList", shareGrantListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/shares/rotate", operationId: "rotateShareGrant",
    requestHeaders: ["idempotencyKey"], requestBody: named("RotateShareGrantRequest", rotateShareGrantRequestSchema),
    response: response(201, "All previous active grants are revoked and one fresh grant is created. The raw token is returned only once. Because only its hash is persisted, retrying the same Idempotency-Key and request performs another safe rotation and returns a new token; reusing the key with a different request is rejected", named("RotateShareGrantResponse", rotateShareGrantResponseSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "post", path: "/projects/{projectId}/shares/revoke-all", operationId: "revokeProjectShareGrants",
    response: response(200, "All active Project Share grants atomically deactivated; repeating this command is safe", named("RevokeProjectShareGrantsResponse", revokeProjectShareGrantsResponseSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/shares/{shareId}", operationId: "getShareGrant",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Share grant snapshot without bearer-token material", named("ShareGrant", shareGrantSchema), ["etag"]),
    additionalResponses: [response(304, "Share revision has not changed")],
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/shares/{shareId}/revoke", operationId: "revokeShareGrant",
    requestHeaders: ["ifMatch"],
    response: response(200, "Share grant revoked without deleting its audit record", named("ShareGrant", shareGrantSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/public/shares/{shareToken}", operationId: "getPublicShare", public: true,
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Public projection of an active immutable release", named("PublicShare", publicShareSchema), ["etag"]),
    additionalResponses: [response(304, "Public release manifest digest matches If-None-Match")],
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/preview-token", operationId: "createSourcePrototypePreviewToken",
    response: response(200, "Short-lived isolated preview for an authorized frozen source prototype", named("ExportPreviewTokenResponse", exportPreviewTokenResponseSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "post", path: "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/preview-token", operationId: "createPublicSourcePrototypePreviewToken", public: true,
    response: response(200, "Short-lived share-bound isolated preview, rechecked for revocation on every access", named("ExportPreviewTokenResponse", exportPreviewTokenResponseSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "get", path: "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}", operationId: "getPublicSharedArtifactVersion", public: true,
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Public projection of an ArtifactVersion pinned by the active shared release", named("PublicArtifactVersionDetail", publicArtifactVersionDetailSchema), ["etag"]),
    additionalResponses: [response(304, "Public ArtifactVersion projection has not changed")],
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/content", operationId: "getPublicSharedArtifactVersionContent", public: true,
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete token-authorized bytes for a blob-backed ArtifactVersion pinned by the active shared release",
      mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested byte range for the pinned shared ArtifactVersion content",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "partial",
      },
      response(304, "Shared ArtifactVersion content digest matches If-None-Match"),
    ],
    rangeProblem: true,
    problemStatuses: problems(404, 503),
  },
  {
    method: "get", path: "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content", operationId: "getPublicSharedArtifactVersionAssetContent", public: true,
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete token-authorized bytes for an ArtifactVersion asset pinned by the active shared release",
      mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested byte range for the pinned shared ArtifactVersion asset",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "partial",
      },
      response(304, "Shared ArtifactVersion asset digest matches If-None-Match"),
    ],
    rangeProblem: true,
    problemStatuses: problems(404, 503),
  },
  {
    method: "post", path: "/public/shares/{shareToken}/remixes", operationId: "createProjectRemix",
    requestHeaders: ["idempotencyKey"],
    requestBody: named("CreateProjectRemixRequest", createProjectRemixRequestSchema),
    response: response(201, "New isolated Project remixed from the immutable shared release", named("CreateProjectRemixResponse", createProjectRemixResponseSchema), ["etag", "location"]),
    problemStatuses: problems(401, 404, 409),
  },
  {
    method: "get", path: "/exports/capabilities", operationId: "getExportCapabilities",
    response: response(200, "Server-authoritative availability catalog for Export formats", named("ExportCapabilities", exportCapabilitiesSchema)),
    problemStatuses: problems(401),
  },
  {
    method: "get", path: "/projects/{projectId}/exports", operationId: "listExportJobs",
    query: cursorPageQuery,
    response: response(200, "Export jobs for immutable Project releases", named("ExportJobList", exportJobListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/exports", operationId: "createExportJob",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateExportJobRequest", createExportJobRequestSchema),
    response: response(202, "Export job durably queued against an immutable release", named("ExportJob", exportJobSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/exports/{exportId}", operationId: "getExportJob",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Export job snapshot", named("ExportJob", exportJobSchema), ["etag"]),
    additionalResponses: [response(304, "Export revision has not changed")],
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/exports/{exportId}/cancel", operationId: "cancelExportJob",
    requestHeaders: ["ifMatch"],
    response: response(200, "Queued or running Export job cancelled", named("ExportJob", exportJobSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "post", path: "/exports/{exportId}/preview-token", operationId: "createExportPreviewToken",
    response: response(200, "Short-lived capability URL for an authorized succeeded HTML Export", named("ExportPreviewTokenResponse", exportPreviewTokenResponseSchema)),
    problemStatuses: problems(404, 409),
  },
  {
    method: "post", path: "/projects/{projectId}/previews", operationId: "createProjectPreview",
    requestHeaders: ["idempotencyKey"],
    requestBody: named("CreateProjectPreviewRequest", createProjectPreviewRequestSchema),
    response: response(202, "Short-lived read-authorized Project preview build", named("ProjectPreview", projectPreviewSchema), ["location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/previews/{previewId}", operationId: "getProjectPreview",
    response: response(200, "Project preview build status", named("ProjectPreview", projectPreviewSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/previews/{previewId}/token", operationId: "createProjectPreviewToken",
    response: response(200, "Short-lived capability URL for an authorized Project preview", named("PreviewTokenResponse", previewTokenResponseSchema)),
    problemStatuses: problems(404, 409),
  },
  {
    method: "get", path: "/exports/{exportId}/content", operationId: "getExportContent",
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete authorized bytes for a succeeded Export job",
      mediaType: "application/octet-stream", headers: ["contentDigestEtag", "contentDisposition"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested single byte range from Export output",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag", "contentDisposition"], byteRange: "partial",
      },
      response(304, "Export output digest matches If-None-Match"),
    ],
    problemStatuses: problems(404, 409, 502), rangeProblem: true,
  },
  {
    method: "get", path: "/exports/{exportId}/deliveries", operationId: "listExternalExportDeliveries",
    response: response(200, "External delivery audit records for one immutable Export output", named("ExternalExportDeliveryList", externalExportDeliveryListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/exports/{exportId}/deliveries", operationId: "createExternalExportDelivery",
    requestHeaders: ["idempotencyKey"],
    requestBody: named("CreateExternalExportDeliveryRequest", createExternalExportDeliveryRequestSchema),
    response: response(201, "External delivery prepared and awaiting explicit user confirmation", named("ExternalExportDelivery", externalExportDeliverySchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/export-deliveries/{deliveryId}", operationId: "getExternalExportDelivery",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "External delivery audit snapshot", named("ExternalExportDelivery", externalExportDeliverySchema), ["etag"]),
    additionalResponses: [response(304, "External delivery revision has not changed")],
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/export-deliveries/{deliveryId}/confirm", operationId: "confirmExternalExportDelivery",
    requestHeaders: ["ifMatch"],
    response: response(202, "Explicitly confirmed external delivery queued", named("ExternalExportDelivery", externalExportDeliverySchema), ["etag"]),
    problemStatuses: problems(404, 409, 412, 428),
  },
  {
    method: "post", path: "/export-deliveries/{deliveryId}/retry", operationId: "retryExternalExportDelivery",
    requestHeaders: ["ifMatch"],
    response: response(202, "Failed external delivery explicitly retried", named("ExternalExportDelivery", externalExportDeliverySchema), ["etag"]),
    problemStatuses: problems(404, 409, 412, 428),
  },
  {
    method: "post", path: "/export-deliveries/{deliveryId}/cancel", operationId: "cancelExternalExportDelivery",
    requestHeaders: ["ifMatch"],
    response: response(202, "External delivery cancellation accepted or already terminal", named("ExternalExportDelivery", externalExportDeliverySchema), ["etag"]),
    problemStatuses: problems(404, 409, 412, 428),
  },
  {
    method: "put", path: "/projects/{projectId}/board", operationId: "replaceBoard",
    requestHeaders: ["ifMatch", "idempotencyKey"], requestBody: named("ReplaceBoardRequest", replaceBoardRequestSchema),
    response: response(200, "Board replaced with compare-and-swap; an identical Idempotency-Key replay returns the first committed result", named("Board", boardSchema), ["etag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/workspaces/{workspaceId}/design-systems", operationId: "listDesignSystemCatalog",
    query: designSystemCatalogPageQuery,
    response: response(200, "Readable ready Design Systems in active Projects in this Workspace", named("DesignSystemCatalog", designSystemCatalogSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "post", path: "/projects/{projectId}/design-systems", operationId: "createDesignSystem",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateDesignSystemRequest", createDesignSystemRequestSchema),
    response: response(201, "Ready workbench.design-system.v1 ArtifactVersion created", named("DesignSystemCreation", designSystemCreationSchema), ["location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "post", path: "/projects/{projectId}/design-system-imports", operationId: "importDesignSystem",
    requestHeaders: ["idempotencyKey"], requestBody: named("ImportDesignSystemRequest", importDesignSystemRequestSchema),
    response: response(201, "Immutable Design System version imported into the target Project", named("DesignSystemImport", designSystemImportSchema), ["location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/projects/{projectId}/artifacts", operationId: "listArtifacts",
    query: cursorPageQuery.extend({ kind: artifactKindSchema.optional() }).strict(),
    response: response(200, "Cursor page of project Artifacts ordered newest first", named("ArtifactList", artifactListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/artifacts", operationId: "createArtifact",
    requestHeaders: ["idempotencyKey"],
    requestBody: named("CreateArtifactRequest", createArtifactRequestSchema),
    response: response(201, "Ready image Artifact and immutable blob-backed ArtifactVersion created from a verified project File", named("ArtifactCreation", artifactCreationSchema), ["location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/projects/{projectId}/artifact-version-favorites", operationId: "listArtifactVersionFavorites",
    query: cursorPageQuery,
    response: response(200, "Current principal's favourite immutable ArtifactVersion targets in this Project", named("ArtifactVersionFavoriteList", artifactVersionFavoriteListSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "get", path: "/artifacts/{artifactId}", operationId: "getArtifact",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Artifact and its current immutable version pointer", named("Artifact", artifactSchema), ["etag"]),
    additionalResponses: [response(304, "Artifact revision has not changed")], problemStatuses: problems(404),
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions", operationId: "listArtifactVersions",
    query: cursorPageQuery,
    response: response(200, "Immutable Artifact versions ordered newest first", named("ArtifactVersionList", artifactVersionListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/artifacts/{artifactId}/versions", operationId: "createArtifactVersion",
    requestHeaders: ["ifMatch", "idempotencyKey"],
    requestBody: named("CreateArtifactVersionRequest", createArtifactVersionRequestSchema),
    response: response(201, "Immutable ready ArtifactVersion created from the current ready base", named("ArtifactVersionDetail", artifactVersionDetailSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions/{artifactVersionId}", operationId: "getArtifactVersion",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Immutable Artifact version content, explicitly inline or blob-backed", named("ArtifactVersionDetail", artifactVersionDetailSchema), ["etag"]),
    additionalResponses: [response(304, "Immutable Artifact version manifest has not changed")], problemStatuses: problems(404),
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/finalization", operationId: "getArtifactFinalization",
    response: response(200, "Owner-visible finalization and ingestion state", named("ArtifactFinalizationState", artifactFinalizationStateSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/finalization", operationId: "confirmArtifactFinalization",
    requestBody: named("ConfirmArtifactFinalizationRequest", confirmArtifactFinalizationRequestSchema),
    response: response(200, "Idempotent immutable-version confirmation and queued project knowledge ingestion", named("ArtifactFinalizationState", artifactFinalizationStateSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "post", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/finalization/retry", operationId: "retryArtifactFinalization",
    response: response(200, "Retry the existing ingestion job using a new release version", named("ArtifactFinalizationState", artifactFinalizationStateSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "post", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/finalization/withdraw", operationId: "withdrawArtifactFinalization",
    response: response(200, "Withdraw this source and retire all derived knowledge releases", named("ArtifactFinalizationState", artifactFinalizationStateSchema)),
    problemStatuses: problems(400, 404),
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/preference", operationId: "getArtifactVersionPreference",
    query: artifactVersionPreferenceTargetQuerySchema,
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Current principal's private preference for an immutable ArtifactVersion", named("ArtifactVersionPreference", artifactVersionPreferenceSchema), ["etag"]),
    additionalResponses: [response(304, "ArtifactVersion preference revision has not changed")], problemStatuses: problems(400, 404),
  },
  {
    method: "put", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/preference", operationId: "updateArtifactVersionPreference",
    query: artifactVersionPreferenceTargetQuerySchema,
    requestHeaders: ["ifMatch"],
    requestBody: named("UpdateArtifactVersionPreferenceRequest", updateArtifactVersionPreferenceRequestSchema),
    response: response(200, "Current principal's private ArtifactVersion preference replaced using compare-and-swap", named("ArtifactVersionPreference", artifactVersionPreferenceSchema), ["etag"]),
    problemStatuses: problems(400, 404, 412, 428),
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/content", operationId: "getArtifactVersionContent",
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete authorized bytes for a blob-backed immutable Artifact version",
      mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested single byte range from blob-backed Artifact content",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "partial",
      },
      response(304, "Artifact content digest matches If-None-Match"),
    ],
    problemStatuses: problems(404, 502), rangeProblem: true,
  },
  {
    method: "get", path: "/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content", operationId: "getArtifactVersionAssetContent",
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete authorized bytes for an asset pinned to an immutable ArtifactVersion",
      mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested single byte range from an asset pinned to an immutable ArtifactVersion",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "partial",
      },
      response(304, "Artifact asset digest matches If-None-Match"),
    ],
    problemStatuses: problems(404, 502), rangeProblem: true,
  },
  {
    method: "get", path: "/projects/{projectId}/files", operationId: "listFiles",
    query: cursorPageQuery.extend({ status: fileStatusSchema.exclude(["deleted"]).optional() }).strict(),
    response: response(200, "Cursor page of non-deleted project files ordered newest first", named("FileList", fileListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/projects/{projectId}/import-sources", operationId: "listImportSources",
    query: cursorPageQuery,
    response: response(200, "Cursor page of project-scoped immutable import sources", named("ImportSourceList", importSourceListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/projects/{projectId}/import-sources", operationId: "createImportSource",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateImportSourceRequest", createImportSourceRequestSchema),
    response: response(201, "Import source registered; local files may be ready immediately and external sources remain pending until a worker freezes them", named("ImportSource", importSourceSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409, 412),
  },
  {
    method: "get", path: "/import-sources/{sourceId}", operationId: "getImportSource",
    response: response(200, "Immutable import source lifecycle snapshot", named("ImportSource", importSourceSchema), ["etag"]),
    problemStatuses: problems(404),
  },
  {
    method: "delete", path: "/import-sources/{sourceId}", operationId: "deleteImportSource",
    requestHeaders: ["ifMatch"],
    response: response(204, "Import source marked deleted without invalidating existing Run snapshots"),
    problemStatuses: problems(404, 409, 412, 428),
  },
  {
    method: "post", path: "/projects/{projectId}/file-upload-sessions", operationId: "createFileUpload",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateFileUploadRequest", createFileUploadRequestSchema),
    response: response(201, "File asset and opaque multipart upload session created", named("CreateFileUploadResponse", createFileUploadResponseSchema), ["uploadRevisionEtag", "location"]),
    problemStatuses: problems(400, 404, 409),
  },
  {
    method: "get", path: "/files/{fileId}", operationId: "getFile", requestHeaders: ["ifNoneMatch"],
    response: response(200, "Safe file lifecycle snapshot without object-storage identifiers", named("FileAsset", fileAssetSchema), ["fileRevisionEtag"]),
    additionalResponses: [response(304, "File revision has not changed")], problemStatuses: problems(404),
  },
  {
    method: "delete", path: "/files/{fileId}", operationId: "deleteFile", requestHeaders: ["ifMatch"],
    response: response(204, "File lifecycle marked deleted; referenced immutable blobs remain retained"),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/files/{fileId}/content", operationId: "getFileContent",
    requestHeaders: ["ifNoneMatch", "byteRange"],
    response: {
      status: 200, description: "Complete verified file bytes", mediaType: "application/octet-stream",
      headers: ["contentDigestEtag"], byteRange: "complete",
    },
    additionalResponses: [
      {
        status: 206, description: "Requested single byte range from verified file content",
        mediaType: "application/octet-stream", headers: ["contentDigestEtag"], byteRange: "partial",
      },
      response(304, "Verified content digest matches If-None-Match"),
    ],
    problemStatuses: problems(404, 409, 502), rangeProblem: true,
  },
  {
    method: "post", path: "/files/{fileId}/extractions", operationId: "createFileExtraction",
    requestHeaders: ["idempotencyKey", "ifMatch"],
    response: response(202, "New extraction attempt queued for the unchanged verified source blob; poll the Location file's latestExtraction", named("FileExtraction", fileExtractionSchema), ["fileRevisionEtag", "location"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/file-upload-sessions/{uploadSessionId}", operationId: "getFileUpload",
    requestHeaders: ["ifNoneMatch"],
    response: response(200, "Opaque multipart upload session state", named("FileUploadSession", fileUploadSessionSchema), ["uploadRevisionEtag"]),
    additionalResponses: [response(304, "Upload session revision has not changed")], problemStatuses: problems(404),
  },
  {
    method: "delete", path: "/file-upload-sessions/{uploadSessionId}", operationId: "abortFileUpload",
    requestHeaders: ["ifMatch"], response: response(204, "Multipart upload aborted or the prior abort replayed"),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/file-upload-sessions/{uploadSessionId}/parts", operationId: "listFileUploadParts",
    response: response(200, "Provider-confirmed uploaded parts in strictly ascending order", named("ListUploadPartsResponse", listUploadPartsResponseSchema)),
    problemStatuses: problems(404, 409),
  },
  {
    method: "post", path: "/file-upload-sessions/{uploadSessionId}/parts/{partNumber}", operationId: "signFileUploadPart",
    requestHeaders: ["ifMatch"], requestBody: named("SignUploadPartRequest", signUploadPartRequestSchema),
    response: response(200, "Short-lived HTTPS request for one opaque upload-session part; loopback HTTP is allowed only in local development", named("SignUploadPartResponse", signUploadPartResponseSchema), ["uploadRevisionEtag"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "post", path: "/file-upload-sessions/{uploadSessionId}/complete", operationId: "completeFileUpload",
    requestHeaders: ["ifMatch", "idempotencyKey"], requestBody: named("CompleteFileUploadRequest", completeFileUploadRequestSchema),
    response: response(202, "Multipart completion accepted and trusted-byte verification queued", named("CompleteFileUploadResponse", completeFileUploadResponseSchema), ["uploadRevisionEtag", "location"]),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "post", path: "/threads/{threadId}/submission-intents", operationId: "createSubmissionIntent",
    requestHeaders: ["idempotencyKey"], requestBody: named("CreateSubmissionIntentRequest", createSubmissionIntentRequestSchema),
    response: response(201, "Durable SubmissionIntent and ordered attachment slots created", named("SubmissionIntent", submissionIntentSchema), ["etag", "location"]),
    problemStatuses: problems(400, 404, 409, 502, 504),
  },
  {
    method: "get", path: "/threads/{threadId}/submission-intents/current", operationId: "getCurrentSubmissionIntent",
    response: response(200, "Current principal's unique active SubmissionIntent in the Thread or a strict null item", named("CurrentSubmissionIntent", currentSubmissionIntentSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/submission-intents/{intentId}", operationId: "getSubmissionIntent",
    response: response(200, "Creator-owned durable SubmissionIntent", named("SubmissionIntent", submissionIntentSchema), ["etag"]),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/submission-intents/{intentId}/submit", operationId: "submitSubmissionIntent",
    response: response(202, "SubmissionIntent submitted through its durable Run idempotency key", named("SubmitSubmissionIntentResponse", submitSubmissionIntentResponseSchema), ["etag", "location"]),
    problemStatuses: problems(404, 409, 502, 504),
  },
  {
    method: "delete", path: "/submission-intents/{intentId}", operationId: "cancelSubmissionIntent",
    requestHeaders: ["ifMatch"],
    response: response(204, "Pending SubmissionIntent cancelled with compare-and-swap"),
    problemStatuses: problems(400, 404, 409, 412, 428),
  },
  {
    method: "get", path: "/threads/{threadId}/runs", operationId: "listRuns", query: cursorPageQuery,
    response: response(200, "Runs for the selected Thread ordered newest first", named("RunList", runListSchema)),
    problemStatuses: problems(404),
  },
  {
    method: "get", path: "/runs/{runId}", operationId: "getRun",
    response: response(200, "Durable Run snapshot", named("Run", runSchema)), problemStatuses: problems(404),
  },
  {
    method: "get", path: "/runs/{runId}/events", operationId: "subscribeRunEvents",
    requestHeaders: ["lastEventId"],
    query: z.object({ afterSequence: z.number().int().nonnegative().optional() }).strict(),
    response: { status: 200, description: "Ordered replay followed by live events. SSE id equals RunEvent sequence.", mediaType: "text/event-stream" },
    problemStatuses: problems(404),
  },
  {
    method: "get",
    path: "/runs/{runId}/artifact-drafts/{artifactVersionId}/checkpoint",
    operationId: "getRunPrototypePatchCheckpoint",
    query: runPrototypePatchCheckpointQuerySchema,
    response: response(
      200,
      "Authoritative Run-scoped Prototype staging checkpoint and per-screen transport revisions",
      named("RunPrototypePatchCheckpoint", runPrototypePatchCheckpointSchema),
    ),
    problemStatuses: problems(404, 409),
  },
  {
    method: "post", path: "/runs/{runId}/cancel", operationId: "cancelRun",
    requestHeaders: ["idempotencyKey"], response: response(202, "Cancellation accepted", named("Run", runSchema)),
    problemStatuses: problems(409),
  },
  {
    method: "post", path: "/runs/{runId}/retry", operationId: "retryRun",
    requestHeaders: ["idempotencyKey"], response: response(202, "Retry Run accepted from the persisted source request", named("Run", runSchema), ["location"]),
    problemStatuses: problems(400, 404, 409, 502, 504),
  },
  {
    method: "get", path: "/runs/{runId}/approvals/{approvalId}", operationId: "getRunApproval",
    response: response(200, "Run approval snapshot", named("RunApproval", runApprovalSchema), ["etag"]),
    problemStatuses: problems(404),
  },
  {
    method: "post", path: "/runs/{runId}/approvals/{approvalId}", operationId: "submitRunApproval",
    requestHeaders: ["idempotencyKey"], requestBody: named("SubmitApprovalRequest", submitApprovalRequestSchema),
    response: response(202, "Approval decision accepted", named("SubmitApprovalResponse", submitApprovalResponseSchema), ["etag", "location"]),
    problemStatuses: problems(409),
  },
  {
    method: "get", path: "/runs/{runId}/approvals", operationId: "listRunApprovals",
    response: response(200, "Ordered Run approvals", named("RunApprovalList", runApprovalListSchema)), problemStatuses: problems(404),
  },
] as const satisfies readonly WorkbenchHttpRoute[];

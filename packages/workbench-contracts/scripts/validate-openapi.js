import fs from "node:fs";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const contractPath = fileURLToPath(new URL("../openapi/workbench.v1.yaml", import.meta.url));
const contract = YAML.parse(fs.readFileSync(contractPath, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolvePointer(pointer) {
  assert(pointer.startsWith("#/"), `Only local OpenAPI refs are allowed: ${pointer}`);
  return pointer.slice(2).split("/").reduce((value, segment) => {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    assert(value && Object.prototype.hasOwnProperty.call(value, key), `Unresolved OpenAPI ref: ${pointer}`);
    return value[key];
  }, contract);
}

function walk(value, visitor, path = []) {
  if (!value || typeof value !== "object") return;
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...path, index]));
    return;
  }
  Object.entries(value).forEach(([key, item]) => walk(item, visitor, [...path, key]));
}

function refNames(schema) {
  return (schema?.oneOf ?? schema?.anyOf ?? []).map((entry) => entry.$ref?.split("/").at(-1));
}

function hasType(schema, expected) {
  return schema?.type === expected || (Array.isArray(schema?.type) && schema.type.includes(expected));
}

function matchesStringComponent(schema, componentName, { nullable = false } = {}) {
  if (schema?.$ref === `#/components/schemas/${componentName}`) return !nullable;
  const component = contract.components.schemas[componentName];
  if (!component || !hasType(schema, "string")) return false;
  if (nullable && !hasType(schema, "null")) return false;
  for (const key of ["pattern", "minLength", "maxLength", "format"]) {
    if (component[key] !== undefined && schema[key] !== component[key]) return false;
  }
  return true;
}

function literalValue(schema) {
  if (Object.prototype.hasOwnProperty.call(schema ?? {}, "const")) return schema.const;
  return Array.isArray(schema?.enum) && schema.enum.length === 1 ? schema.enum[0] : undefined;
}

function literalValues(schema) {
  const directValue = literalValue(schema);
  if (directValue !== undefined) return [directValue];
  return (schema?.oneOf ?? schema?.anyOf ?? [])
    .map((entry) => literalValue(resolveSchema(entry)))
    .filter((value) => value !== undefined);
}

function resolveSchema(schema) {
  return schema?.$ref ? resolvePointer(schema.$ref) : schema;
}

function requiresPositiveInteger(schema) {
  return schema?.type === "integer"
    && (schema.minimum === 1 || schema.exclusiveMinimum === 0);
}

if (contract.openapi !== "3.1.0") throw new Error("The Workbench contract must use OpenAPI 3.1.0");
if (!contract.paths || Object.keys(contract.paths).length === 0) throw new Error("The Workbench contract has no paths");
assert(Object.keys(contract.paths).length === 96, "Workbench v1 must expose exactly 96 resource paths including Artifact finalization");
const operationCount = Object.values(contract.paths).reduce((count, pathItem) => (
  count + ["get", "post", "put", "patch", "delete"].filter((method) => pathItem?.[method]).length
), 0);
assert(operationCount === 118, "Workbench v1 must expose exactly 118 generated operations including Artifact finalization");
for (const [path, methods] of [
  ["/artifacts/{artifactId}/versions/{artifactVersionId}/finalization", ["get", "post"]],
  ["/artifacts/{artifactId}/versions/{artifactVersionId}/finalization/retry", ["post"]],
  ["/artifacts/{artifactId}/versions/{artifactVersionId}/finalization/withdraw", ["post"]],
]) {
  for (const method of methods) assert(contract.paths[path]?.[method], `Artifact finalization requires ${method} ${path}`);
}
if (!contract.components?.schemas?.ProblemDetails) throw new Error("ProblemDetails is required");
if (contract.paths["/threads/{threadId}/runs"]?.post) throw new Error("Direct Run creation must remain behind SubmissionIntent submission");
if (!contract.paths["/threads/{threadId}/runs"]?.get) throw new Error("Thread Run discovery is required");
const projectImportSources = contract.paths["/projects/{projectId}/import-sources"];
const importSource = contract.paths["/import-sources/{sourceId}"];
assert(projectImportSources?.get && projectImportSources?.post && importSource?.get && importSource?.delete, "Import Source create/list/get/delete routes are required");
assert(projectImportSources.post.requestBody?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CreateImportSourceRequest", "Import Source creation must use the typed source request union");
assert(projectImportSources.post.responses?.["201"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ImportSource", "Import Source creation must return its lifecycle snapshot");
assert(importSource.delete.parameters?.some((parameter) => parameter.$ref === "#/components/parameters/IfMatch"), "Import Source deletion must use If-Match");
if (!contract.paths["/projects/{projectId}/threads"]?.post) throw new Error("The Thread command is required");
if (!contract.paths["/runs/{runId}/events"]?.get) throw new Error("The Run SSE replay endpoint is required");
const prototypePatchCheckpoint = contract.paths["/runs/{runId}/artifact-drafts/{artifactVersionId}/checkpoint"]?.get;
assert(prototypePatchCheckpoint, "The Run-scoped Prototype patch checkpoint endpoint is required");
assert(
  prototypePatchCheckpoint.responses?.["200"]?.content?.["application/json"]?.schema?.$ref
    === "#/components/schemas/RunPrototypePatchCheckpoint",
  "Prototype patch checkpoint recovery must return RunPrototypePatchCheckpoint",
);
if (!contract.paths["/runs/{runId}/retry"]?.post) throw new Error("The persisted-request Run retry command is required");
if (!contract.paths["/runs/{runId}/approvals/{approvalId}"]?.post) throw new Error("The approval command is required");
if (!contract.paths["/runtime/models"]?.get) throw new Error("The runtime model catalog is required");
assert(contract.paths["/design-presets"]?.get, "The authenticated authoritative Design preset catalog is required");
assert(contract.paths["/design-presets"].get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/DesignPresetCatalog", "The Design preset endpoint must return DesignPresetCatalog");
const knowledgeTool = contract.paths["/runtime/knowledge/retrieve"]?.post;
assert(knowledgeTool, "The scoped Runtime Knowledge retrieval tool is required");
assert(JSON.stringify(knowledgeTool.security) === JSON.stringify([{ knowledgeGrant: [] }]), "Runtime Knowledge retrieval must use only its scoped capability grant");
assert(knowledgeTool.requestBody?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/KnowledgeToolRequest", "Runtime Knowledge retrieval must use KnowledgeToolRequest");
assert(knowledgeTool.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/KnowledgeToolResponse", "Runtime Knowledge retrieval must return KnowledgeToolResponse");
const canvasTool = contract.paths["/runtime/canvas/tools/execute"]?.post;
assert(canvasTool, "The scoped Runtime Canvas tool endpoint is required");
assert(JSON.stringify(canvasTool.security) === JSON.stringify([{ canvasGrant: [] }]), "Runtime Canvas tools must use only their scoped capability grant");
assert(canvasTool.requestBody?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasAgentToolInvocation", "Runtime Canvas tools must use the minimal invocation envelope");
assert(canvasTool.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasAgentToolResult", "Runtime Canvas tools must return CanvasAgentToolResult");
const canvasVisual = contract.paths["/runtime/canvas/visuals/{visualCapabilityId}"]?.get;
assert(canvasVisual, "The scoped Runtime Canvas visual endpoint is required");
assert(JSON.stringify(canvasVisual.security) === JSON.stringify([{ canvasGrant: [] }]), "Canvas visuals must use only their scoped capability grant");
assert(canvasVisual.responses?.["200"]?.content?.["application/octet-stream"]?.schema?.type === "string", "Canvas visuals must return binary image bytes");
const canvasCommands = contract.paths["/projects/{projectId}/canvas-agent/commands"]?.get;
const canvasCommandAck = contract.paths["/projects/{projectId}/canvas-agent/commands/{commandId}/ack"]?.post;
const canvasClientState = contract.paths["/projects/{projectId}/canvas-agent/state"]?.put;
assert(canvasClientState && canvasCommands && canvasCommandAck, "Authenticated Canvas client-state, command polling, and ACK routes are required");
assert(
  canvasClientState.security === undefined
    && canvasCommands.security === undefined
    && canvasCommandAck.security === undefined,
  "Browser Canvas state and command routes must inherit OIDC authentication and never use capability grants",
);
assert(canvasClientState.requestBody?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasClientStateSyncRequest", "Canvas client-state synchronization must use CanvasClientStateSyncRequest");
assert(canvasClientState.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasClientStateSyncResponse", "Canvas client-state synchronization must return CanvasClientStateSyncResponse");
assert(canvasCommands.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasClientCommandList", "Canvas command polling must return CanvasClientCommandList");
assert(canvasCommandAck.requestBody?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/CanvasClientCommandAckRequest", "Canvas command ACK must use the wire-only CanvasClientCommandAckRequest");
for (const [apiPath, method] of [
  ["/knowledge/profiles", "get"],
  ["/knowledge/profiles", "post"],
  ["/knowledge/profiles/{profileType}/{profileId}", "get"],
  ["/knowledge/profiles/{profileType}/{profileId}/promote", "post"],
  ["/knowledge/profiles/{profileType}/{profileId}/retire", "post"],
  ["/knowledge/profile-adoption-receipts", "get"],
]) {
  assert(contract.paths[apiPath]?.[method], `${method.toUpperCase()} ${apiPath} is required`);
  assert(contract.paths[apiPath][method].responses["401"], `${method.toUpperCase()} ${apiPath} must declare authentication failure`);
}
assert(contract.paths["/knowledge/profiles"].post.responses["201"].content["application/json"].schema.$ref === "#/components/schemas/KnowledgeProfile", "Knowledge Profile creation must return the canonical Profile");
assert(contract.paths["/knowledge/profiles/{profileType}/{profileId}/promote"].post.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/KnowledgeProfilePromotionResult", "Knowledge Profile promotion must return adoption evidence when entering adopted");
assert(contract.paths["/knowledge/profile-adoption-receipts"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/KnowledgeProfileAdoptionReceiptList", "Knowledge Profile adoption receipt listing must use the immutable receipt schema");
assert(!contract.paths["/knowledge/profile-adoption-receipts"].post
  && !contract.paths["/knowledge/profile-adoption-receipts"].put
  && !contract.paths["/knowledge/profile-adoption-receipts"].patch
  && !contract.paths["/knowledge/profile-adoption-receipts"].delete,
"Knowledge Profile adoption receipts must be query-only");
for (const [apiPath, method] of [
  ["/projects/{projectId}", "delete"],
  ["/projects/{projectId}/duplicate", "post"],
  ["/projects/{projectId}/members", "get"],
  ["/projects/{projectId}/members/{principalId}", "put"],
  ["/projects/{projectId}/members/{principalId}", "delete"],
  ["/projects/{projectId}/invitations", "get"],
  ["/projects/{projectId}/invitations", "post"],
  ["/projects/{projectId}/invitations/{invitationId}", "delete"],
  ["/project-invitations/preview", "post"],
  ["/project-invitations/accept", "post"],
  ["/workspaces/{workspaceId}/members", "get"],
  ["/workspaces/{workspaceId}/design-systems", "get"],
  ["/projects/{projectId}/design-systems", "post"],
  ["/projects/{projectId}/design-system-imports", "post"],
  ["/projects/{projectId}/shares/revoke-all", "post"],
]) {
  assert(contract.paths[apiPath]?.[method], `${method.toUpperCase()} ${apiPath} is required`);
}
assert(contract.paths["/projects/{projectId}/invitations"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectInvitationList", "Project invitation listing must use ProjectInvitationList");
assert(contract.paths["/projects/{projectId}/invitations"].post.responses["201"].content["application/json"].schema.$ref === "#/components/schemas/CreateProjectInvitationResponse", "Project invitation creation must return the one-time delivery response");
assert(contract.paths["/projects/{projectId}/invitations/{invitationId}"].delete.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectInvitation", "Project invitation revocation must return ProjectInvitation");
assert(contract.paths["/project-invitations/preview"].post.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectInvitationPreview", "Invitation preview must use ProjectInvitationPreview");
assert(contract.paths["/project-invitations/accept"].post.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/AcceptProjectInvitationResponse", "Invitation acceptance must return both the invitation and Project membership");
assert(contract.paths["/workspaces/{workspaceId}/design-systems"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/DesignSystemCatalog", "Workspace Design System catalog must use DesignSystemCatalog");
assert(contract.paths["/projects/{projectId}/artifacts"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ArtifactList", "Project Artifact listing must use ArtifactList");
const artifactVersionFavorites = contract.paths["/projects/{projectId}/artifact-version-favorites"];
assert(artifactVersionFavorites?.get, "Project-scoped ArtifactVersion favourite listing is required");
assert(!artifactVersionFavorites.post && !artifactVersionFavorites.put
  && !artifactVersionFavorites.patch && !artifactVersionFavorites.delete,
"Project-scoped ArtifactVersion favourites must remain query-only");
const listArtifactVersionFavorites = artifactVersionFavorites.get;
assert(listArtifactVersionFavorites.operationId === "listArtifactVersionFavorites", "Project favourite listing must keep its stable operationId");
assert(listArtifactVersionFavorites.security === undefined, "Project favourite listing must inherit OIDC bearer authentication");
assert(JSON.stringify(contract.security) === JSON.stringify([{ oidcBearer: [] }]), "Workbench authenticated routes must inherit OIDC bearer authentication by default");
const favoriteParameters = listArtifactVersionFavorites.parameters ?? [];
assert(favoriteParameters.some((parameter) => parameter.$ref === "#/components/parameters/ProjectId"), "Project favourite listing must bind the ProjectId path parameter");
const projectIdParameter = contract.components?.parameters?.ProjectId;
assert(projectIdParameter?.name === "projectId" && projectIdParameter.in === "path"
  && projectIdParameter.required === true
  && projectIdParameter.schema?.$ref === "#/components/schemas/ProjectId"
  && matchesStringComponent(contract.components?.schemas?.ProjectId, "OpaqueId"),
"Project favourite listing must use the required opaque ProjectId path contract");
const favoriteCursor = favoriteParameters.find((parameter) => parameter.name === "cursor");
assert(favoriteCursor?.in === "query" && favoriteCursor.required === false
  && favoriteCursor.schema?.type === "string"
  && favoriteCursor.schema.pattern === undefined && favoriteCursor.schema.format === undefined
  && favoriteCursor.schema.enum === undefined,
"Project favourite listing cursor must remain an optional opaque query string");
const favoriteLimit = favoriteParameters.find((parameter) => parameter.name === "limit");
assert(favoriteLimit?.in === "query" && favoriteLimit.required === false
  && favoriteLimit.schema?.type === "integer" && favoriteLimit.schema.minimum === 1
  && favoriteLimit.schema.maximum === 100 && favoriteLimit.schema.default === 30,
"Project favourite listing limit must stay within the shared cursor-page bounds");
assert(listArtifactVersionFavorites.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ArtifactVersionFavoriteList", "Project favourite listing must return ArtifactVersionFavoriteList");
for (const status of ["400", "404"]) {
  assert(listArtifactVersionFavorites.responses?.[status]?.$ref === "#/components/responses/Problem", `Project favourite listing ${status} errors must use ProblemDetails`);
}
const favoriteListSchema = contract.components?.schemas?.ArtifactVersionFavoriteList;
assert(favoriteListSchema?.additionalProperties === false
  && favoriteListSchema.required?.includes("items")
  && favoriteListSchema.required?.includes("nextCursor"),
"ArtifactVersionFavoriteList must remain a closed cursor page");
assert(favoriteListSchema.properties?.items?.maxItems === 100
  && favoriteListSchema.properties.items.items?.$ref === "#/components/schemas/ArtifactVersionFavoriteListItem",
"ArtifactVersionFavoriteList must contain at most 100 typed favourite targets");
const favoriteNextCursor = favoriteListSchema.properties?.nextCursor;
assert(Array.isArray(favoriteNextCursor?.type)
  && favoriteNextCursor.type.includes("string") && favoriteNextCursor.type.includes("null")
  && favoriteNextCursor.minLength === 1
  && favoriteNextCursor.pattern === undefined && favoriteNextCursor.format === undefined,
"ArtifactVersionFavoriteList nextCursor must remain a nullable opaque non-empty string");
assert(contract.paths["/artifacts/{artifactId}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/Artifact", "Artifact detail must use Artifact");
assert(contract.paths["/artifacts/{artifactId}/versions"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ArtifactVersionList", "Artifact version listing must use ArtifactVersionList");
assert(contract.paths["/artifacts/{artifactId}/versions/{artifactVersionId}"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref === "#/components/schemas/ArtifactVersionDetail", "Artifact version detail must use ArtifactVersionDetail");
assert(contract.paths["/artifacts/{artifactId}/versions/{artifactVersionId}/content"]?.get?.responses?.["200"]?.content?.["application/octet-stream"]?.schema?.format === "binary", "Artifact content must be an authorized byte stream");
for (const field of ["workflow", "targetSurface", "designStyle", "requestedArtifactKinds"]) {
  if (!contract.components?.schemas?.Run?.required?.includes(field)) {
    throw new Error(`Run must expose ${field} for refresh recovery`);
  }
}
if (!contract.components?.schemas?.Run?.required?.includes("sources")) {
  throw new Error("Run must expose immutable Import Source snapshots for refresh recovery");
}
if (!contract.components?.schemas?.Run?.required?.includes("retryOfRunId")) {
  throw new Error("Run must expose retry lineage for refresh recovery");
}
for (const field of ["phase", "progress", "lastEventSequence", "failure", "cancellationReason"]) {
  if (!contract.components?.schemas?.Run?.required?.includes(field)) {
    throw new Error(`Run must expose ${field} for durable refresh recovery`);
  }
}
if (!contract.components?.schemas?.ProjectBootstrap?.required?.includes("selectedThreadId")
  || !contract.components?.schemas?.ProjectBootstrap?.required?.includes("latestRun")
  || !contract.components?.schemas?.ProjectBootstrap?.required?.includes("access")) {
  throw new Error("ProjectBootstrap must bind entries and latest Run to a selected Thread");
}
if (contract.components?.schemas?.ThreadEntry?.properties?.content?.$ref !== "#/components/schemas/ThreadEntryContent") {
  throw new Error("ThreadEntry must use the versioned content union");
}
if (!contract.components?.schemas?.ApprovalOption || !contract.components?.schemas?.JsonValue) {
  throw new Error("Stable approval and JSON value schemas are required");
}

const schemas = contract.components.schemas;
for (const requiredSchema of [
  "ArtifactCitation", "PrdDocument", "PrdSections", "PrdBlock", "PrdInline",
  "PrototypeDocument", "PrototypeNode", "PrototypeLayout", "PrototypeStyle",
  "PrototypeToken", "PrototypeAsset", "PrototypeState", "PrototypeAction",
  "PrototypeBinding", "PrototypeMotion", "PrototypePatchOperation", "PrototypePatchBatch",
  "PrototypePatchEventPayload", "PrototypePatchDegradedEventPayload", "PrototypeScreenProjection",
  "RuntimePrototypePatchInput", "RunPrototypePatchCheckpoint", "RuntimeArtifactDraft",
  "RuntimeArtifactDraftPrd", "RuntimeArtifactDraftPrototype", "RuntimeArtifactDraftImage",
  "RuntimeArtifactDraftCode", "RuntimeArtifactDraftDocument", "RuntimeArtifactDraftData",
  "ArtifactList", "ArtifactVersionList", "ArtifactVersionDetail", "ArtifactVersionInlineDetail",
  "ArtifactVersionBlobDetail",
  "Sha256", "SafeInteger", "UploadObjectByteSize", "UploadPartByteSize", "UploadPartSize",
  "MediaType", "FileName", "MultipartETag",
  "FileFailure", "FileExtraction", "FileAsset", "FileUploadSession", "CreateFileUploadRequest",
  "CreateFileUploadResponse", "SignUploadPartRequest", "SignUploadPartResponse", "UploadedPart",
  "CompletedPart", "ListUploadPartsResponse", "CompleteFileUploadRequest",
  "CompleteFileUploadResponse", "FileList", "ImportSource", "ImportSourceBlob",
  "ImportSourceDescriptor", "ImportSourceList", "CreateImportSourceRequest",
  "RunSourceIds", "RunSourceSnapshotManifest", "RunSourceSnapshot",
  "RunWorkflow", "RunTargetSurface", "RunDesignStyle", "RunDesignStyleAutomatic",
  "RunDesignStylePreset", "RunDesignStyleArtifact",
  "ProjectRole", "ProjectRelationship", "ProjectListItem", "ProjectList",
  "DuplicateProjectRequest", "ProjectDuplicate", "ProjectMember", "ProjectMemberList",
  "SetProjectMemberRoleRequest", "WorkspaceRole", "WorkspaceMember", "WorkspaceMemberList",
  "DesignSystemDocument", "PublicDesignSystemDocument", "RuntimeDesignStyleSnapshot",
  "DesignPresetCatalog", "DesignPresetCatalogItem", "DesignPresetDefinition",
  "DesignPresetReference", "RuntimePresetDesignStyleSnapshot",
  "DesignSystemCatalog", "DesignSystemCatalogItem", "CreateDesignSystemRequest", "DesignSystemCreation",
  "ImportDesignSystemRequest", "DesignSystemImport",
  "RuntimeRequestedArtifactKind",
  "CreateKnowledgeProfileRequest", "EmbeddingKnowledgeProfile", "RetrievalKnowledgeProfile",
  "KnowledgeProfile", "KnowledgeProfileList", "KnowledgeProfilePromotionResult",
  "KnowledgeProfileAdoptionReceipt", "KnowledgeProfileAdoptionReceiptList",
  "PromoteKnowledgeProfileRequest", "RetireKnowledgeProfileRequest",
]) {
  assert(schemas[requiredSchema], `${requiredSchema} is required`);
}

const expectedFilePaths = [
  "/projects/{projectId}/files",
  "/projects/{projectId}/file-upload-sessions",
  "/files/{fileId}",
  "/files/{fileId}/content",
  "/files/{fileId}/extractions",
  "/file-upload-sessions/{uploadSessionId}",
  "/file-upload-sessions/{uploadSessionId}/parts",
  "/file-upload-sessions/{uploadSessionId}/parts/{partNumber}",
  "/file-upload-sessions/{uploadSessionId}/complete",
];
for (const apiPath of expectedFilePaths) assert(contract.paths[apiPath], `${apiPath} is required`);
const fileOperationCount = expectedFilePaths.reduce((count, apiPath) => count +
  ["get", "post", "delete"].filter((method) => contract.paths[apiPath][method]).length, 0);
assert(fileOperationCount === 11, "The first file API slice must expose exactly 11 HTTP operations");

const parameterNames = (operation) => (operation?.parameters ?? []).map((parameter) =>
  parameter.$ref?.split("/").at(-1) ?? parameter.name,
);
const assertCommandHeaders = (apiPath, method, { idempotency, ifMatch }) => {
  const operation = contract.paths[apiPath]?.[method];
  assert(operation, `${method.toUpperCase()} ${apiPath} is required`);
  const names = parameterNames(operation);
  assert(names.includes("IdempotencyKey") === idempotency, `${operation.operationId} Idempotency-Key requirement is incorrect`);
  assert(names.includes("IfMatch") === ifMatch, `${operation.operationId} If-Match requirement is incorrect`);
};
assertCommandHeaders("/projects/{projectId}/file-upload-sessions", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/knowledge/profiles", "post", { idempotency: false, ifMatch: false });
assertCommandHeaders("/projects/{projectId}", "patch", { idempotency: false, ifMatch: true });
assertCommandHeaders("/projects/{projectId}", "delete", { idempotency: false, ifMatch: true });
assertCommandHeaders("/projects/{projectId}/duplicate", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/projects/{projectId}/design-systems", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/projects/{projectId}/design-system-imports", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/projects/{projectId}/members/{principalId}", "put", { idempotency: false, ifMatch: true });
assertCommandHeaders("/projects/{projectId}/members/{principalId}", "delete", { idempotency: false, ifMatch: true });
assertCommandHeaders("/identity/preferences", "get", { idempotency: false, ifMatch: false });
assertCommandHeaders("/identity/preferences", "put", { idempotency: false, ifMatch: true });
assertCommandHeaders("/artifacts/{artifactId}/versions/{artifactVersionId}/preference", "get", { idempotency: false, ifMatch: false });
assertCommandHeaders("/artifacts/{artifactId}/versions/{artifactVersionId}/preference", "put", { idempotency: false, ifMatch: true });
assertCommandHeaders("/files/{fileId}", "delete", { idempotency: false, ifMatch: true });
assertCommandHeaders("/files/{fileId}/extractions", "post", { idempotency: true, ifMatch: true });
assertCommandHeaders("/file-upload-sessions/{uploadSessionId}", "delete", { idempotency: false, ifMatch: true });
assertCommandHeaders("/file-upload-sessions/{uploadSessionId}/parts/{partNumber}", "post", { idempotency: false, ifMatch: true });
assertCommandHeaders("/file-upload-sessions/{uploadSessionId}/complete", "post", { idempotency: true, ifMatch: true });
assertCommandHeaders("/projects/{projectId}/releases", "post", { idempotency: true, ifMatch: true });
assertCommandHeaders("/projects/{projectId}/shares/rotate", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/public/shares/{shareToken}/remixes", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/projects/{projectId}/exports", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/projects/{projectId}/previews", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/shares/{shareId}/revoke", "post", { idempotency: false, ifMatch: true });
assertCommandHeaders("/exports/{exportId}/cancel", "post", { idempotency: false, ifMatch: true });
assertCommandHeaders("/exports/{exportId}/deliveries", "post", { idempotency: true, ifMatch: false });
assertCommandHeaders("/export-deliveries/{deliveryId}/confirm", "post", { idempotency: false, ifMatch: true });
assertCommandHeaders("/export-deliveries/{deliveryId}/retry", "post", { idempotency: false, ifMatch: true });
assertCommandHeaders("/export-deliveries/{deliveryId}/cancel", "post", { idempotency: false, ifMatch: true });

assert(contract.paths["/projects"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectList", "Cross-Workspace Project listing must use the role-aware ProjectList");
assert(!contract.paths["/workspaces/{workspaceId}/projects"].get, "Workspace-scoped Project listing must not remain as a compatibility endpoint");
assert(contract.paths["/workspaces/{workspaceId}/members"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/WorkspaceMemberList", "Workspace member discovery must use WorkspaceMemberList");
assert(schemas.WorkspaceMember.additionalProperties === false, "WorkspaceMember must reject private or unknown identity fields");
assert(JSON.stringify(Object.keys(schemas.WorkspaceMember.properties).sort()) === JSON.stringify([
  "displayName", "email", "principalId", "role",
]), "WorkspaceMember must expose only collaborator discovery identity and Workspace role fields");
assert(schemas.WorkspaceMemberList.additionalProperties === false, "WorkspaceMemberList must reject unknown pagination fields");
assert(contract.paths["/projects/{projectId}/duplicate"].post.responses["201"].content["application/json"].schema.$ref === "#/components/schemas/ProjectDuplicate", "Private duplicate must return ProjectDuplicate");
assert(contract.paths["/projects/{projectId}/members"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectMemberList", "Project membership listing must use ProjectMemberList");
assert(contract.paths["/projects/{projectId}/members/{principalId}"].put.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ProjectMember", "Project membership mutation must return ProjectMember");
assert(contract.paths["/projects/{projectId}/members/{principalId}"].delete.responses["204"], "Project member removal must return 204");

for (const apiPath of [
  "/projects/{projectId}/releases", "/releases/{releaseId}",
  "/projects/{projectId}/shares", "/projects/{projectId}/shares/rotate", "/shares/{shareId}", "/shares/{shareId}/revoke",
  "/public/shares/{shareToken}",
  "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}",
  "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/content",
  "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content",
  "/public/shares/{shareToken}/remixes",
  "/exports/capabilities", "/projects/{projectId}/exports", "/exports/{exportId}", "/exports/{exportId}/cancel",
  "/exports/{exportId}/preview-token", "/exports/{exportId}/content",
  "/exports/{exportId}/deliveries", "/export-deliveries/{deliveryId}",
  "/export-deliveries/{deliveryId}/confirm", "/export-deliveries/{deliveryId}/retry",
  "/export-deliveries/{deliveryId}/cancel",
  "/projects/{projectId}/previews", "/previews/{previewId}", "/previews/{previewId}/token",
]) {
  assert(contract.paths[apiPath], `${apiPath} is required`);
}
assert(!contract.paths["/shares/{shareId}"]?.delete, "Share grants must be revoked semantically, never deleted");
for (const [apiPath, method] of [
  ["/public/shares/{shareToken}", "get"],
  ["/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}", "get"],
  ["/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/content", "get"],
  ["/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content", "get"],
]) {
  assert(JSON.stringify(contract.paths[apiPath][method].security) === "[]", `${apiPath} must use only its active Share token capability`);
}
assert(contract.paths["/public/shares/{shareToken}/remixes"].post.security === undefined, "Remix must inherit OIDC bearer authentication");
assert(contract.paths["/exports/capabilities"].get.security === undefined, "Export capabilities must inherit OIDC bearer authentication");
assert(contract.paths["/exports/capabilities"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ExportCapabilities", "Export capability catalog must use ExportCapabilities");
assert(!contract.paths["/exports/{exportId}/preview-token"].post.requestBody, "Preview capability TTL and origin must not be client-controlled");
assert(contract.paths["/exports/{exportId}/content"].get.responses["200"].headers["Content-Disposition"], "Export download must provide a safe attachment disposition");
assert(contract.paths["/exports/{exportId}/deliveries"].post.requestBody.content["application/json"].schema.$ref === "#/components/schemas/CreateExternalExportDeliveryRequest", "External Export delivery creation must accept only its target command");
assert(contract.paths["/exports/{exportId}/deliveries"].post.responses["201"].content["application/json"].schema.$ref === "#/components/schemas/ExternalExportDelivery", "External Export delivery creation must return its audit snapshot");
assert(contract.paths["/exports/{exportId}/deliveries"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ExternalExportDeliveryList", "External Export delivery listing must return the bounded audit list");
for (const action of ["confirm", "retry", "cancel"]) {
  assert(!contract.paths[`/export-deliveries/{deliveryId}/${action}`].post.requestBody, `${action} External Export delivery must not accept client payload or credentials`);
}
const publicAssetContent = contract.paths["/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content"].get;
const publicArtifactContent = contract.paths["/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/content"].get;
assert(publicArtifactContent.responses["200"].headers.ETag.$ref === "#/components/headers/ContentDigestETag", "Public shared Artifact content ETag must identify immutable bytes");
assert(publicArtifactContent.responses["206"].headers["Content-Range"], "Public shared Artifact content partial responses must identify the served range");
assert(publicArtifactContent.responses["416"].$ref === "#/components/responses/RangeProblem", "Public shared Artifact content unsatisfied ranges must use RangeProblem");
assert(publicAssetContent.responses["200"].headers.ETag.$ref === "#/components/headers/ContentDigestETag", "Public shared asset ETag must identify immutable bytes");
assert(publicAssetContent.responses["206"].headers["Content-Range"], "Public shared asset partial responses must identify the served range");
assert(publicAssetContent.responses["416"].$ref === "#/components/responses/RangeProblem", "Public shared asset unsatisfied ranges must use RangeProblem");

for (const requiredSchema of [
  "ProjectRelease", "PublicProjectRelease", "ProjectReleaseArtifactPin", "ProjectReleaseArtifactAssetPin", "ProjectReleaseManifest",
  "ShareGrant", "RotateShareGrantResponse", "PublicShare", "PublicArtifactVersionDetail",
  "PublicArtifactVersionInlineDetail", "PublicArtifactVersionBlobDetail", "PublicArtifactContentBlob",
  "PublicPrototypeDocument", "PublicPrototypeAsset", "PublicPrototypeImageAsset", "PublicPrototypeFontAsset",
  "CreateProjectRemixResponse",
  "ExportJob", "ExportSelection", "ExportFormat", "ExportPackaging", "ExportCapabilities", "ExportCapability", "FigmaExportCapability",
  "ExportCapabilityUnavailableReason", "ExportPreviewTokenResponse", "ExternalExportTarget", "ExternalExportAuthentication",
  "CreateExternalExportDeliveryRequest", "ExternalExportPayloadSnapshot", "ExternalExportDelivery", "ExternalExportDeliveryList",
  "CreateProjectPreviewRequest", "ProjectPreview", "PreviewTokenResponse",
]) {
  assert(schemas[requiredSchema], `${requiredSchema} is required`);
}
assert(!schemas.PublicProjectRelease.properties.createdById, "PublicProjectRelease must not expose creator principal ids");
assert(schemas.PublicShare.properties.release.$ref === "#/components/schemas/PublicProjectRelease", "PublicShare must use the principal-free Release projection");
for (const forbiddenField of ["token", "tokenHash", "storageKey", "createdById"]) {
  assert(!schemas.PublicShare.properties[forbiddenField], `PublicShare must not expose ${forbiddenField}`);
}
assert(!schemas.ShareGrant.properties.tokenHash && !schemas.ShareGrant.properties.token, "ShareGrant must not expose bearer-token material");
assert(JSON.stringify(refNames(schemas.PublicArtifactVersionDetail)) === JSON.stringify([
  "PublicArtifactVersionInlineDetail", "PublicArtifactVersionInlinePrdV2Detail", "PublicArtifactVersionBlobDetail",
]), "PublicArtifactVersionDetail must preserve the legacy inline branch and add PRD v2 independently");
for (const forbiddenField of ["createdByRunId", "knowledgeReleaseId", "contentBlobId", "storageKey", "tokenHash"]) {
  assert(!schemas.PublicArtifactVersionBlobDetail.properties[forbiddenField], `PublicArtifactVersionBlobDetail must not expose ${forbiddenField}`);
}
assert(!schemas.PublicArtifactContentBlob.properties.blobId, "PublicArtifactContentBlob must not expose Blob identity");
assert(!schemas.PublicPrototypeImageAsset.properties.blobId, "Public Prototype image assets must not expose Blob identity");
assert(!schemas.PublicPrototypeFontAsset.properties.blobId, "Public Prototype font assets must not expose Blob identity");
assert(schemas.RotateShareGrantResponse.properties.token.$ref === "#/components/schemas/ShareToken", "Raw Share token must exist only in the rotation response");
for (const field of ["title", "kind", "version", "schemaVersion", "checksum", "assets"]) {
  assert(schemas.ProjectReleaseArtifactPin.required.includes(field), `ProjectRelease Artifact pins must freeze ${field}`);
}
assert(!schemas.PublicProjectReleaseArtifactPin.properties.assets, "Public Release pins must not expose internal Blob asset identities");
for (const field of ["assetId", "kind", "blobId", "mediaType", "byteSize", "sha256", "metadata"]) {
  assert(schemas.ProjectReleaseArtifactAssetPin.required.includes(field), `ProjectRelease binary asset pins must freeze ${field}`);
}
assert(JSON.stringify(schemas.ExportSelection.oneOf.map((option) => literalValue(option.properties.kind))) === JSON.stringify(["release", "board", "board_nodes", "artifact"]), "ExportSelection variants changed without a contract update");
const boardNodesExportSelection = schemas.ExportSelection.oneOf.find((option) => literalValue(option.properties.kind) === "board_nodes");
assert(boardNodesExportSelection.properties.nodeIds.$ref === "#/components/schemas/ExportBoardNodeIds", "Board-node ExportSelection must use the canonical node id schema");
assert(schemas.ExportBoardNodeIds.uniqueItems === true, "Board-node ExportSelection ids must be unique");
assert(schemas.ExportBoardNodeIds.minItems === 1 && schemas.ExportBoardNodeIds.maxItems === 512, "Board-node ExportSelection must stay bounded to 1..512 nodes");
const artifactExportSelection = schemas.ExportSelection.oneOf.find((option) => literalValue(option.properties.kind) === "artifact");
assert(artifactExportSelection.properties.screenId, "Artifact ExportSelection must expose optional screenId");
assert(!artifactExportSelection.required.includes("screenId"), "Artifact ExportSelection screenId must remain optional");
assert(schemas.ExportPreviewTokenResponse.additionalProperties === false, "Preview capability response must reject internal fields");
assert(JSON.stringify(Object.keys(schemas.ExportPreviewTokenResponse.properties).sort()) === JSON.stringify(["expiresAt", "url"]), "Preview capability must expose only url and expiresAt");
for (const field of ["format", "packaging"]) {
  assert(schemas.ExportJob.required.includes(field), `ExportJob must freeze ${field}`);
  assert(schemas.CreateExportJobRequest.required.includes(field), `CreateExportJobRequest must explicitly choose ${field}`);
}
const formatCapabilities = resolveSchema(schemas.ExportCapabilities.properties.formats);
const packagingCapabilities = resolveSchema(schemas.ExportCapabilities.properties.packaging);
const externalCapabilities = resolveSchema(schemas.ExportCapabilities.properties.external);
assert(JSON.stringify(Object.keys(formatCapabilities.properties)) === JSON.stringify(["html", "react", "figma", "mcp", "docx", "pdf"]), "Export format capabilities must remain explicit");
assert(JSON.stringify(Object.keys(packagingCapabilities.properties)) === JSON.stringify(["single_file", "zip"]), "Export packaging capabilities must remain explicit");
assert(JSON.stringify(Object.keys(externalCapabilities.properties)) === JSON.stringify(["ai_studio", "netlify", "lovable", "bolt"]), "External Export target capabilities must remain explicit");
for (const capability of [
  ...Object.values(formatCapabilities.properties),
  ...Object.values(packagingCapabilities.properties),
  ...Object.values(externalCapabilities.properties),
]) {
  assert(capability.$ref === "#/components/schemas/AvailableExportCapability", "Every Export capability entry must use the audited capability state contract");
}
assert(JSON.stringify(Object.keys(schemas.CreateExternalExportDeliveryRequest.properties)) === JSON.stringify(["target"]), "External delivery creation must accept only a named target");
assert(!schemas.ExternalExportPayloadSnapshot.properties.output.properties.url
  && !schemas.ExternalExportPayloadSnapshot.properties.output.properties.token
  && !schemas.ExternalExportPayloadSnapshot.properties.output.properties.storageKey,
"External delivery payload snapshots must not expose URLs, credentials, or internal storage keys");
for (const forbiddenField of ["token", "oauthToken", "accessToken", "storageKey"]) {
  assert(!schemas.ExternalExportDelivery.properties[forbiddenField], `ExternalExportDelivery must not expose ${forbiddenField}`);
}

for (const apiPath of expectedFilePaths) {
  for (const method of ["get", "post", "delete"]) {
    const operation = contract.paths[apiPath]?.[method];
    if (!operation) continue;
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      if (Number(status) < 400) continue;
      const responseObject = response.$ref ? resolvePointer(response.$ref) : response;
      assert(responseObject.content?.["application/problem+json"]?.schema?.$ref === "#/components/schemas/ProblemDetails", `${operation.operationId} ${status} must use ProblemDetails`);
    }
  }
}

assert(contract.paths["/projects/{projectId}/files"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/FileList", "Project file listing must use FileList");
assert(contract.paths["/projects/{projectId}/file-upload-sessions"].post.responses["201"].content["application/json"].schema.$ref === "#/components/schemas/CreateFileUploadResponse", "Upload creation must return CreateFileUploadResponse");
assert(contract.paths["/file-upload-sessions/{uploadSessionId}/parts"].get.responses["200"].content["application/json"].schema.$ref === "#/components/schemas/ListUploadPartsResponse", "Part listing must use ListUploadPartsResponse");
assert(contract.paths["/file-upload-sessions/{uploadSessionId}/complete"].post.responses["202"].content["application/json"].schema.$ref === "#/components/schemas/CompleteFileUploadResponse", "Upload completion must return CompleteFileUploadResponse");

for (const schemaName of ["FileAsset", "FileUploadSession", "ImportSource", "RunSourceSnapshot"]) {
  for (const forbiddenField of ["storageKey", "stagingKey", "providerUploadId", "requestHash", "idempotencyKey"]) {
    assert(!schemas[schemaName].properties?.[forbiddenField], `${schemaName} must not expose ${forbiddenField}`);
  }
  assert(schemas[schemaName].additionalProperties === false, `${schemaName} must reject unknown fields`);
}
assert(schemas.FileAsset.properties.byteSize.$ref === "#/components/schemas/SafeInteger", "FileAsset byteSize must be a safe nonnegative integer");
assert(matchesStringComponent(schemas.FileAsset.properties.sha256, "Sha256", { nullable: true }), "FileAsset sha256 must use the strict nullable digest schema");
assert(matchesStringComponent(schemas.FileAsset.properties.declaredMediaType, "MediaType"), "FileAsset MIME values must use MediaType");
assert(schemas.FileAsset.required.includes("latestExtraction"), "FileAsset must expose the latest extraction for queued/running polling");
assert(schemas.CreateFileUploadRequest.properties.byteSize.$ref === "#/components/schemas/UploadObjectByteSize", "Upload creation must enforce the S3 object-size limit");
assert(requiresPositiveInteger(schemas.UploadObjectByteSize), "User uploads must reject empty objects");
assert(schemas.UploadObjectByteSize.maximum === 25 * 1024 ** 2, "User uploads must match the 25 MiB verification ceiling");
assert(requiresPositiveInteger(schemas.UploadPartByteSize), "Multipart upload parts must reject empty bodies");
assert(!schemas.CreateFileUploadRequest.required.includes("sha256"), "Upload creation sha256 must remain an optional untrusted hint");
assert(matchesStringComponent(schemas.CreateFileUploadRequest.properties.sha256, "Sha256"), "Optional upload creation sha256 must use the strict digest schema");
assert(schemas.FileUploadSession.properties.partSize.$ref === "#/components/schemas/UploadPartSize", "Upload partSize must fit S3 and database bounds");
assert(schemas.SignUploadPartRequest.properties.contentLength.$ref === "#/components/schemas/UploadPartByteSize", "Signed parts must enforce the S3 part-size limit");
assert(schemas.UploadedPart.properties.etag.$ref === "#/components/schemas/MultipartETag", "Uploaded part ETags must use MultipartETag");
assert(schemas.CompletedPart.properties.etag.$ref === "#/components/schemas/MultipartETag", "Completed part ETags must use MultipartETag");
assert(schemas.ListUploadPartsResponse.properties.parts.uniqueItems === true, "Listed upload parts must be unique");
assert(schemas.ListUploadPartsResponse.properties.parts.description.includes("strictly ascending"), "Listed upload parts must be ordered");
assert(schemas.CompleteFileUploadRequest.properties.parts.uniqueItems === true, "Completed upload parts must be unique");
assert(schemas.CompleteFileUploadRequest.properties.parts.description.includes("strictly ascending"), "Completed upload parts must be ordered");
assert(!schemas.CompleteFileUploadRequest.required.includes("sha256"), "Upload completion sha256 must remain optional");
assert(matchesStringComponent(schemas.CompleteFileUploadRequest.properties.sha256, "Sha256"), "Optional upload completion sha256 must use the strict digest schema");
assert(resolveSchema(schemas.StartRunRequest.properties.sourceIds).uniqueItems === true, "StartRun sourceIds must be unique");
const runArtifactTargets = resolveSchema(schemas.StartRunRequest.properties.artifactTargets);
const runArtifactTarget = resolveSchema(runArtifactTargets.items);
assert(runArtifactTargets.maxItems === 12, "StartRun artifactTargets must be bounded");
assert(schemas.Run.required.includes("artifactTargets"), "Run Artifact target snapshot must be explicit");
assert(resolveSchema(schemas.Run.properties.artifactTargets).description.includes("original request order"), "Run Artifact target order must be explicit");
assert(resolveSchema(runArtifactTarget.properties.screenIds).uniqueItems === true, "Run Artifact target screen ids must be unique");
for (const field of ["workflow", "targetSurface", "designStyle"]) {
  assert(schemas.StartRunRequest.required.includes(field), `StartRun ${field} must be explicit`);
  assert(schemas.Run.required.includes(field), `Run ${field} snapshot must be explicit`);
}
assert(schemas.StartRunRequest.properties.workflow.$ref === "#/components/schemas/RunWorkflow", "StartRun workflow must use the typed workflow schema");
assert(schemas.StartRunRequest.properties.targetSurface.$ref === "#/components/schemas/RunTargetSurface", "StartRun targetSurface must use the typed target schema");
assert(schemas.StartRunRequest.properties.designStyle.$ref === "#/components/schemas/RunDesignStyle", "StartRun designStyle must use the typed style union");
assert(!resolveSchema(schemas.RuntimeRequestedArtifactKind).enum.includes("design_system"), "Runtime must not generate Design System Artifacts");
assert(JSON.stringify(refNames(schemas.RunDesignStyle)) === JSON.stringify([
  "RunDesignStyleAutomatic", "RunDesignStylePreset", "RunDesignStyleArtifact",
]), "RunDesignStyle variants changed without a contract update");
for (const field of ["presetId", "version", "checksum"]) {
  assert(schemas.RunDesignStylePreset.required.includes(field), `Run preset selections must require ${field}`);
}
assert(schemas.RunDesignStylePreset.properties.checksum.$ref === "#/components/schemas/DesignPresetChecksum", "Run preset selections must pin the authoritative checksum");
for (const field of ["presetId", "version", "checksum", "label", "swatch", "description", "directives", "tokens"]) {
  assert(schemas.DesignPresetCatalogItem.required.includes(field), `DesignPresetCatalogItem must include ${field}`);
}
const startRunWorkflowDescription = schemas.StartRunRequest.description ?? "";
for (const invariant of [
  "Redesign requires a ready Import Source",
  "Edit requires an Artifact target",
  "Generate accepts explicit non-empty screen targets only when prototype is requested",
  "Redesign and Ideate forbid targets",
]) {
  assert(
    startRunWorkflowDescription.includes(invariant),
    `The StartRun workflow invariant must be documented in OpenAPI: ${invariant}`,
  );
}
assert(schemas.Run.properties.sources.items.$ref === "#/components/schemas/RunSourceSnapshot", "Run sources must use immutable snapshot DTOs");
assert(schemas.Run.properties.sources.description.includes("contiguous"), "Run source order must be explicit");
assert(schemas.RunSourceSnapshot.properties.snapshot.$ref === "#/components/schemas/RunSourceSnapshotManifest", "Run sources must expose a frozen manifest");
assert(matchesStringComponent(schemas.RunSourceSnapshotManifest.properties.checksum, "Sha256"), "Run source manifests must pin their checksum");
assert(schemas.RunSourceSnapshotManifest.properties.blobs.items.additionalProperties === false, "Run source manifest blobs must reject internal or unknown fields");
assert(resolveSchema(contract.components.parameters.IfMatch.schema).pattern === '^"(?:0|[1-9][0-9]*)"$', "If-Match must require a byte-canonical strong numeric entity tag");
assert(resolveSchema(schemas.SignUploadPartResponse.properties.url).not, "Signed upload URLs must reject userinfo and fragments");
assert(resolveSchema(schemas.SignedUploadHeaders).additionalProperties.pattern, "Signed upload header values must reject control characters");
assert(contract.components.responses.RangeProblem.headers?.["Content-Range"], "A 416 response must include Content-Range");
assert(contract.paths["/projects/{projectId}/file-upload-sessions"].post.responses["201"].headers.ETag.$ref === "#/components/headers/UploadRevisionETag", "Upload creation ETag must identify the upload revision");
assert(contract.paths["/files/{fileId}"].get.responses["200"].headers.ETag.$ref === "#/components/headers/FileRevisionETag", "File detail ETag must identify the file revision");
assert(contract.paths["/files/{fileId}/content"].get.responses["200"].headers.ETag.$ref === "#/components/headers/ContentDigestETag", "File content ETag must identify immutable bytes");
const communicationPreferences = contract.paths["/identity/preferences"];
assert(communicationPreferences.get.responses["200"].headers.ETag.$ref === "#/components/headers/ETag", "Communication preference reads must expose the principal preference revision ETag");
assert(communicationPreferences.put.responses["200"].headers.ETag.$ref === "#/components/headers/ETag", "Communication preference writes must expose the updated revision ETag");
assert(communicationPreferences.put.requestBody.content["application/json"].schema.$ref === "#/components/schemas/UpdateCommunicationPreferencesRequest", "Communication preference writes must use the explicit opt-in request contract");
const artifactVersionPreference = contract.paths["/artifacts/{artifactId}/versions/{artifactVersionId}/preference"];
const hasScreenTarget = (operation) => operation.parameters.some((parameter) => (
  parameter.name === "screenId"
  && parameter.in === "query"
  && parameter.required === false
  && parameter.schema?.minLength === 1
));
assert(hasScreenTarget(artifactVersionPreference.get), "ArtifactVersion preference reads must accept an optional non-empty screenId target");
assert(hasScreenTarget(artifactVersionPreference.put), "ArtifactVersion preference writes must accept an optional non-empty screenId target");
assert(artifactVersionPreference.get.responses["200"].headers.ETag.$ref === "#/components/headers/ETag", "ArtifactVersion preference reads must expose the private preference revision ETag");
assert(artifactVersionPreference.put.responses["200"].headers.ETag.$ref === "#/components/headers/ETag", "ArtifactVersion preference writes must expose the updated revision ETag");
assert(artifactVersionPreference.put.requestBody.content["application/json"].schema.$ref === "#/components/schemas/UpdateArtifactVersionPreferenceRequest", "ArtifactVersion preference writes must use the private preference request contract");

const expectedPrdSections = [
  "executiveSummary", "problem", "goals", "targetUsers", "scope", "requirements",
  "userFlows", "acceptanceCriteria", "risksAndDependencies",
];
assert(JSON.stringify(schemas.PrdSections.required) === JSON.stringify(expectedPrdSections), "PrdSections must expose the fixed ordered v1 section keys");
assert(schemas.PrdSections.additionalProperties === false, "PrdSections must reject unknown section keys");

const expectedPrdBlocks = [
  "PrdParagraphBlock", "PrdHeadingBlock", "PrdBulletListBlock", "PrdOrderedListBlock",
  "PrdTableBlock", "PrdCalloutBlock", "PrdGoalBlock", "PrdPersonaBlock",
  "PrdRequirementBlock", "PrdAcceptanceCriterionBlock", "PrdFlowBlock", "PrdRiskBlock",
];
assert(JSON.stringify(refNames(schemas.PrdBlock)) === JSON.stringify(expectedPrdBlocks), "PrdBlock whitelist changed without a protocol version bump");
assert(JSON.stringify(refNames(schemas.PrdInline)) === JSON.stringify([
  "PrdTextInline", "PrdLinkInline", "PrdCitationInline", "PrdReferenceInline",
]), "PrdInline whitelist changed without a protocol version bump");
assert(JSON.stringify(refNames(schemas.PrdDocument)) === JSON.stringify([
  "PrdDocumentV1", "PrdDocumentV2",
]), "PrdDocument must expose the supported v1/v2 protocol union");
assert(literalValue(schemas.PrdDocumentV1.properties.protocol) === "workbench.prd.v1", "PrdDocumentV1 protocol must be workbench.prd.v1");
assert(literalValue(schemas.PrdDocumentV2.properties.protocol) === "workbench.prd.v2", "PrdDocumentV2 protocol must be workbench.prd.v2");
assert(JSON.stringify(schemas.PrdDocumentV2.required) === JSON.stringify([
  "protocol", "documentId", "title", "revision", "cover", "versionHistory",
  "tableOfContents", "assumptions", "citations", "sections",
]), "PrdDocumentV2 must retain the complete requirement-document structure");
assert(literalValue(schemas.PrdDocumentV2.properties.tableOfContents.properties.title) === "目 录", "PrdDocumentV2 must retain the fixed table-of-contents title");
assert(schemas.PrdDocumentV2.properties.tableOfContents.properties.entries.minItems === 11
  && schemas.PrdDocumentV2.properties.tableOfContents.properties.entries.maxItems === 61,
"PrdDocumentV2 must retain 11 fixed table-of-contents entries and allow up to 50 additional business sections");
const additionalPrdSections = schemas.PrdDocumentV2.properties.sections.properties.businessRequirements.properties.additionalSections;
assert(additionalPrdSections.items.$ref === "#/components/schemas/PrdAdditionalBusinessSection"
  && additionalPrdSections.maxItems === 50
  && JSON.stringify(additionalPrdSections.default) === "[]",
"PrdDocumentV2 additional business sections must default to an empty, bounded typed array");
assert(!schemas.PrdDocumentV2.properties.sections.properties.businessRequirements.required.includes("additionalSections"),
  "PrdDocumentV2 must accept legacy v2 input without additional business sections");
assert(schemas.PrdDocumentV2.properties.sections.properties.introduction.properties.usageScenarios.properties.channelTable.properties.rows.minItems === 3
  && schemas.PrdDocumentV2.properties.sections.properties.introduction.properties.usageScenarios.properties.channelTable.properties.rows.maxItems === 3,
"PrdDocumentV2 must retain exactly three canonical channel rows");
assert(schemas.PrdDocumentV2.properties.sections.properties.businessRequirements.properties.flowAndPages.properties.diagrams.minItems === 2
  && schemas.PrdDocumentV2.properties.sections.properties.businessRequirements.properties.flowAndPages.properties.diagrams.maxItems === 2,
"PrdDocumentV2 must retain the product-flow and product-architecture diagrams");
assert(schemas.PrdDocumentV2.properties.sections.properties.safetyBaseline.properties.rows.minItems === 21
  && schemas.PrdDocumentV2.properties.sections.properties.safetyBaseline.properties.rows.maxItems === 21,
"PrdDocumentV2 must retain the complete 21-row safety baseline");
assert(JSON.stringify(schemas.PrdSafetyBaselineRow.properties.applicability.enum) === JSON.stringify([
  "是", "否", "不涉及",
]), "PRD safety applicability must remain a closed three-value contract");

const expectedPrototypeNodes = [
  "PrototypeFrameNode", "PrototypeFormNode", "PrototypeTextNode", "PrototypeIconNode",
  "PrototypeImageNode", "PrototypeVectorNode", "PrototypeButtonNode", "PrototypeInputNode",
];
assert(JSON.stringify(refNames(schemas.PrototypeNode)) === JSON.stringify(expectedPrototypeNodes), "PrototypeNode whitelist changed without a protocol version bump");
assert(literalValue(schemas.PrototypeDocument.properties.protocol) === "workbench.prototype.v1", "PrototypeDocument protocol must be workbench.prototype.v1");
assert(schemas.PrototypeStyle.required.includes("rotation"), "PrototypeStyle v1 must require static rotation");
assert(schemas.PrototypeStyle.required.includes("transformOrigin"), "PrototypeStyle v1 must require transformOrigin");
assert(schemas.PrototypeRotation.minimum === -180 && schemas.PrototypeRotation.exclusiveMaximum === 180, "PrototypeRotation must stay canonical in [-180, 180)");
assert(schemas.PrototypeTransformOrigin.properties.x.minimum === 0 && schemas.PrototypeTransformOrigin.properties.x.maximum === 1, "PrototypeTransformOrigin.x must stay normalized to [0, 1]");
assert(schemas.PrototypeTransformOrigin.properties.y.minimum === 0 && schemas.PrototypeTransformOrigin.properties.y.maximum === 1, "PrototypeTransformOrigin.y must stay normalized to [0, 1]");
for (const field of ["screens", "nodes", "tokens", "assets", "states", "actions", "bindings", "motions"]) {
  assert(schemas.PrototypeDocument.required.includes(field), `PrototypeDocument must require ${field}`);
}

assert(JSON.stringify(refNames(schemas.ArtifactVersionDetail)) === JSON.stringify([
  "ArtifactVersionInlineDetail", "ArtifactVersionInlinePrdV2Detail", "ArtifactVersionBlobDetail",
]), "ArtifactVersionDetail must preserve the legacy inline branch and add PRD v2 independently");
for (const [schemaName, kind] of [
  ["ArtifactVersionInlinePrdDetail", "prd"],
  ["ArtifactVersionInlinePrdV2Detail", "prd"],
  ["ArtifactVersionInlinePrototypeDetail", "prototype"],
  ["ArtifactVersionInlineDesignSystemDetail", "design_system"],
  ["ArtifactVersionInlineImageDetail", "image"],
  ["ArtifactVersionInlineCodeDetail", "code"],
  ["ArtifactVersionInlineDocumentDetail", "document"],
  ["ArtifactVersionInlineDataDetail", "data"],
]) {
  assert(literalValue(schemas[schemaName].properties.kind) === kind, `${schemaName} must retain kind ${kind}`);
}
assert(literalValue(schemas.ArtifactVersionInlinePrdDetail.properties?.schemaVersion) === 1, "Inline PRD v1 schemaVersion must be 1");
assert(literalValue(schemas.ArtifactVersionInlinePrdV2Detail.properties?.schemaVersion) === 2, "Inline PRD v2 schemaVersion must be 2");
assert(schemas.ArtifactVersionInlinePrdDetail.properties?.content?.$ref === "#/components/schemas/PrdDocumentV1", "Inline PRD v1 must retain the legacy response shape");
assert(schemas.ArtifactVersionInlinePrdV2Detail.properties?.content?.$ref === "#/components/schemas/PrdDocumentV2", "Inline PRD v2 must use the fixed requirement-document contract");
assert(literalValue(schemas.ArtifactVersionInlinePrototypeDetail.properties?.schemaVersion) === 1, "Inline Prototype schemaVersion must be 1");
assert(literalValue(schemas.ArtifactVersionInlineDesignSystemDetail.properties?.schemaVersion) === 1, "Inline Design System schemaVersion must be 1");
assert(schemas.Artifact.required.includes("revision"), "Artifact must expose its mutable revision");
for (const schemaName of [
  "ArtifactVersionBlobDetail", "ArtifactVersionInlinePrdDetail", "ArtifactVersionInlinePrdV2Detail",
  "ArtifactVersionInlinePrototypeDetail",
  "ArtifactVersionInlineDesignSystemDetail",
  "ArtifactVersionInlineImageDetail", "ArtifactVersionInlineCodeDetail",
  "ArtifactVersionInlineDocumentDetail", "ArtifactVersionInlineDataDetail",
]) {
  assert(schemas[schemaName].required.includes("knowledgeReleaseId"), `${schemaName} must expose knowledgeReleaseId`);
}
assert(!schemas.ArtifactContentBlob.properties.downloadUrl && !schemas.ArtifactContentBlob.properties.expiresAt, "Artifact blob metadata must not advertise an unimplemented or expiring URL");
assert(JSON.stringify(refNames(schemas.RuntimeArtifactDraft)) === JSON.stringify([
  "RuntimeArtifactDraftPrd", "RuntimeArtifactDraftPrototype", "RuntimeArtifactDraftImage",
  "RuntimeArtifactDraftCode", "RuntimeArtifactDraftDocument", "RuntimeArtifactDraftData",
]), "RuntimeArtifactDraft must be kind-discriminated");
assert(schemas.RuntimeArtifactDraft.description.includes("top-level citations exactly match"), "RuntimeArtifactDraft must document its citation equality refinement");
for (const [schemaName, kind] of [
  ["RuntimeArtifactDraftPrototype", "prototype"],
  ["RuntimeArtifactDraftImage", "image"],
  ["RuntimeArtifactDraftCode", "code"],
  ["RuntimeArtifactDraftDocument", "document"],
  ["RuntimeArtifactDraftData", "data"],
]) {
  assert(literalValue(schemas[schemaName].properties.kind) === kind, `${schemaName} must retain kind ${kind}`);
}
assert(JSON.stringify(refNames(schemas.RuntimeArtifactDraftPrd)) === JSON.stringify([
  "RuntimeArtifactDraftPrdV1Revision", "RuntimeArtifactDraftPrdV2",
]), "Runtime PRD drafts must expose version-paired v1 revision and v2 branches");
for (const [schemaName, version, contentSchema] of [
  ["RuntimeArtifactDraftPrdV1Revision", 1, "PrdDocumentV1"],
  ["RuntimeArtifactDraftPrdV2", 2, "PrdDocumentV2"],
]) {
  assert(literalValue(schemas[schemaName].properties.kind) === "prd", `${schemaName} must retain kind prd`);
  assert(literalValue(schemas[schemaName].properties.schemaVersion) === version, `${schemaName} must bind schemaVersion ${version}`);
  assert(schemas[schemaName].properties.content.$ref === `#/components/schemas/${contentSchema}`, `${schemaName} must bind ${contentSchema}`);
}
assert(literalValue(schemas.RuntimeArtifactDraftPrdV1Revision.properties.operation.properties.kind) === "revise", "Runtime PRD v1 must remain revision-only");
assert(JSON.stringify(schemas.RuntimeArtifactDraftPrdV2.properties.operation.oneOf.map((option) => literalValue(option.properties.kind))) === JSON.stringify(["create", "revise"]), "Runtime PRD v2 must allow create and revise operations");
assert(literalValue(schemas.RuntimeArtifactDraftPrototype.properties.schemaVersion) === 1, "Runtime Prototype draft schemaVersion must be 1");
for (const schemaName of ["RuntimeArtifactDraftImage", "RuntimeArtifactDraftCode", "RuntimeArtifactDraftDocument", "RuntimeArtifactDraftData"]) {
  assert(schemas[schemaName].properties.content.$ref === "#/components/schemas/JsonValue", `${schemaName} must use JsonValue`);
}

assert(JSON.stringify(schemas.JsonValue.oneOf.map((option) => option.type)) === JSON.stringify([
  "string", "number", "boolean", "null", "array", "object",
]), "JsonValue recursive override must match the audited Zod union branches");
const signedUrlPattern = new RegExp(resolveSchema(schemas.SignUploadPartResponse.properties.url).pattern);
for (const url of [
  "http://localhost", "http://LOCALHOST", "http://127.0.0.1", "http://[::1]",
  "https://example.com", "HTTPS://EXAMPLE.COM/path",
]) {
  assert(signedUrlPattern.test(url), `SignedUploadUrl OpenAPI pattern rejects runtime-valid URL ${url}`);
}

const operationIds = [];
for (const pathItem of Object.values(contract.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    if (pathItem[method]?.operationId) operationIds.push(pathItem[method].operationId);
  }
}
assert(new Set(operationIds).size === operationIds.length, "OpenAPI operationId values must be unique");

walk(contract, (value) => {
  if (typeof value.$ref === "string") resolvePointer(value.$ref);
});

const forbiddenEscapeFields = new Set(["raw", "rawCss", "rawHtml", "customCss", "customHtml", "css", "html", "svg"]);
for (const [name, schema] of Object.entries(schemas)) {
  if (!name.startsWith("Prototype")) continue;
  walk(schema, (value, valuePath) => {
    if (!value.properties) return;
    for (const field of Object.keys(value.properties)) {
      assert(!forbiddenEscapeFields.has(field), `${name} exposes forbidden escape field ${field} at ${valuePath.join(".")}`);
    }
  });
}

process.stdout.write(`Validated ${Object.keys(contract.paths).length} Workbench API paths\n`);

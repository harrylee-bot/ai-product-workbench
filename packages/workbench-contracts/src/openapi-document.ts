import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  zodToOpenAPIRegistry,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { z, type ZodTypeAny } from "zod";
import * as approvalSchemas from "./approvals.js";
import * as artifactSchemas from "./artifacts.js";
import * as boardSchemas from "./boards.js";
import * as canvasAgentSchemas from "./canvas-agent-tools.js";
import * as bootstrapSchemas from "./bootstrap.js";
import * as citationSchemas from "./citations.js";
import * as commonSchemas from "./common.js";
import * as designSystemSchemas from "./design-systems.js";
import * as designPresetSchemas from "./design-presets.js";
import * as fileSchemas from "./files.js";
import * as finalizationSchemas from "./finalizations.js";
import * as documentSchemas from "./documents.js";
import * as exportSchemas from "./exports.js";
import * as previewSchemas from "./previews.js";
import {
  workbenchHttpRoutes,
  type NamedWorkbenchSchema,
  type WorkbenchHttpRoute,
  type WorkbenchRouteResponse,
} from "./http-routes.js";
import * as identitySchemas from "./identity.js";
import * as importSourceSchemas from "./import-sources.js";
import * as invitationSchemas from "./invitations.js";
import * as knowledgeSchemas from "./knowledge.js";
import * as prdSchemas from "./prd.js";
import * as projectSchemas from "./projects.js";
import * as releaseSchemas from "./releases.js";
import * as prototypePatchSchemas from "./prototype-patches.js";
import * as prototypeSchemas from "./prototype.js";
import * as queueSchemas from "./queues.js";
import * as runSchemas from "./runs.js";
import * as runtimeModelSchemas from "./runtime-models.js";
import * as runtimeSchemas from "./runtime.js";
import * as systemSchemas from "./system.js";
import * as shareSchemas from "./shares.js";
import * as sourcePrototypeSchemas from "./source-prototype.js";
import * as submissionIntentSchemas from "./submission-intents.js";
import * as threadSchemas from "./threads.js";
import * as visualPrototypeSchemas from "./visual-prototype.js";
import * as workspaceSchemas from "./workspaces.js";

type OpenApiMetadata = Record<string, unknown>;

const schemaNameOverrides: Readonly<Record<string, string>> = {
  httpEntityTagSchema: "HttpEntityTag",
  multipartEtagSchema: "MultipartETag",
  signedHeadersSchema: "SignedUploadHeaders",
};

function isZodSchema(value: unknown): value is ZodTypeAny {
  return Boolean(value && typeof value === "object" && typeof (value as ZodTypeAny).safeParse === "function");
}

function schemaName(exportName: string) {
  const withoutSuffix = exportName.slice(0, -"Schema".length);
  return schemaNameOverrides[exportName]
    ?? `${withoutSuffix.charAt(0).toUpperCase()}${withoutSuffix.slice(1)}`;
}

function schemasFrom(module: Record<string, unknown>, filter: (exportName: string) => boolean = () => true) {
  return Object.entries(module)
    .filter(([exportName, value]) => exportName.endsWith("Schema") && filter(exportName) && isZodSchema(value))
    .map(([exportName, schema]) => ({ name: schemaName(exportName), schema: schema as ZodTypeAny }));
}

function unionOptions(schema: ZodTypeAny): ZodTypeAny[] {
  const options = (schema as unknown as { options?: ZodTypeAny[] }).options;
  if (!options) throw new Error(`Expected union options for ${typeName(schema)}`);
  return [...options];
}

function buildSchemaCatalog() {
  const catalog = [
    ...schemasFrom(commonSchemas),
    ...schemasFrom(approvalSchemas),
    ...schemasFrom(citationSchemas),
    ...schemasFrom(designSystemSchemas),
    ...schemasFrom(designPresetSchemas),
    ...schemasFrom(prdSchemas),
    ...schemasFrom(prototypeSchemas),
    ...schemasFrom(prototypePatchSchemas),
    ...schemasFrom(artifactSchemas),
    ...schemasFrom(boardSchemas),
    ...schemasFrom(canvasAgentSchemas),
    ...schemasFrom(bootstrapSchemas),
    ...schemasFrom(fileSchemas),
    ...schemasFrom(finalizationSchemas),
    ...schemasFrom(documentSchemas),
    ...schemasFrom(exportSchemas),
    ...schemasFrom(previewSchemas),
    ...schemasFrom(identitySchemas),
    ...schemasFrom(importSourceSchemas),
    ...schemasFrom(invitationSchemas),
    ...schemasFrom(knowledgeSchemas),
    ...schemasFrom(projectSchemas),
    ...schemasFrom(releaseSchemas),
    ...schemasFrom(runSchemas, (name) => !name.includes("Event")),
    ...schemasFrom(runtimeModelSchemas),
    ...schemasFrom(systemSchemas),
    ...schemasFrom(shareSchemas),
    ...schemasFrom(sourcePrototypeSchemas),
    ...schemasFrom(submissionIntentSchemas),
    ...schemasFrom(threadSchemas),
    ...schemasFrom(workspaceSchemas),
    ...schemasFrom(visualPrototypeSchemas),
  ];

  const designStyles = unionOptions(runSchemas.runDesignStyleSchema);
  catalog.push(
    { name: "RunDesignStyleAutomatic", schema: designStyles[0]! },
    { name: "RunDesignStylePreset", schema: designStyles[1]! },
    { name: "RunDesignStyleArtifact", schema: designStyles[2]! },
  );

  catalog.push(
    { name: "RuntimeArtifactDraftPrd", schema: runtimeSchemas.runtimeArtifactDraftPrdSchema },
    { name: "RuntimeArtifactDraftPrototype", schema: runtimeSchemas.runtimeArtifactDraftPrototypeSchema },
    { name: "RuntimeArtifactDraftImage", schema: runtimeSchemas.runtimeArtifactDraftImageSchema },
    { name: "RuntimeArtifactDraftCode", schema: runtimeSchemas.runtimeArtifactDraftCodeSchema },
    { name: "RuntimeArtifactDraftDocument", schema: runtimeSchemas.runtimeArtifactDraftDocumentSchema },
    { name: "RuntimeArtifactDraftData", schema: runtimeSchemas.runtimeArtifactDraftDataSchema },
    { name: "RuntimeArtifactDraft", schema: runtimeSchemas.runtimeArtifactDraftContractSchema },
    { name: "RuntimeResult", schema: runtimeSchemas.runtimeResultContractSchema },
  );

  const seenNames = new Set<string>();
  const unique = catalog.filter(({ name }) => {
      if (seenNames.has(name)) throw new Error(`Duplicate OpenAPI schema name: ${name}`);
      seenNames.add(name);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const canonicalBySchema = new Map<ZodTypeAny, (typeof unique)[number]>();
  for (const entry of unique) {
    if (!canonicalBySchema.has(entry.schema)) canonicalBySchema.set(entry.schema, entry);
  }
  const dependencies = (entry: (typeof unique)[number]) => {
    const found = new Set<(typeof unique)[number]>();
    const visited = new Set<ZodTypeAny>();
    const visit = (schema: ZodTypeAny) => {
      if (visited.has(schema)) return;
      visited.add(schema);
      for (const child of childSchemas(schema)) {
        const dependency = canonicalBySchema.get(child);
        if (dependency && dependency.schema !== entry.schema) found.add(dependency);
        else visit(child);
      }
    };
    visit(entry.schema);
    return [...found].sort((left, right) => left.name.localeCompare(right.name));
  };

  const ordered: typeof unique = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (entry: (typeof unique)[number]) => {
    if (visited.has(entry.name)) return;
    if (visiting.has(entry.name)) return;
    visiting.add(entry.name);
    dependencies(entry).forEach(visit);
    visiting.delete(entry.name);
    visited.add(entry.name);
    ordered.push(entry);
  };
  unique.forEach(visit);
  return ordered;
}

function applyOpenApiMetadata(schema: ZodTypeAny, metadata: OpenApiMetadata) {
  zodToOpenAPIRegistry.add(schema, { ...zodToOpenAPIRegistry.get(schema), ...metadata });
}

function typeName(schema: ZodTypeAny) {
  // ZodPreprocess is a pipe whose input is a transform in Zod 4.6.
  return schema._zod.def.type === "pipe" ? "ZodPipe" : schema.constructor.name;
}

function unwrapToObject(schema: ZodTypeAny): z.ZodObject {
  let current = schema;
  while (["ZodDefault", "ZodOptional", "ZodNullable", "ZodReadonly"].includes(typeName(current))) {
    const definition = (current as unknown as { _def: Record<string, ZodTypeAny> })._def;
    current = definition.innerType;
  }
  if (typeName(current) !== "ZodObject") throw new Error(`Expected ZodObject, received ${typeName(current)}`);
  return current as z.ZodObject;
}

function directCustomChecks(schema: ZodTypeAny): object[] {
  const definition = schema._zod.def as unknown as {
    checks?: { _zod: { def: { check: string } } }[];
    in?: ZodTypeAny;
    innerType?: ZodTypeAny;
  };
  const checks: object[] = (definition.checks ?? []).filter((check) => check._zod.def.check === "custom");
  if (typeName(schema) === "ZodPipe" && definition.in && typeName(definition.in) === "ZodTransform") {
    checks.push(definition.in);
  }
  if (["ZodDefault", "ZodOptional", "ZodNullable", "ZodReadonly"].includes(typeName(schema)) && definition.innerType) {
    checks.push(...directCustomChecks(definition.innerType));
  }
  return checks;
}

type ReviewedCheck = Readonly<{
  label: string;
  schema: ZodTypeAny;
  description: string;
}>;

const reviewedCheckSchemas: readonly ReviewedCheck[] = [
  { label: "BusinessDocument.body", schema: documentSchemas.businessDocumentSchema, description: "A business document contains exactly one nonempty text or Markdown body; enforced by the runtime Zod contract." },
  { label: "ApprovalOptions.uniqueIds", schema: approvalSchemas.approvalOptionsSchema, description: "Approval option ids are unique; enforced by the runtime Zod contract." },
  { label: "ArtifactVersionBlobDetail.schemaVersion", schema: artifactSchemas.artifactVersionBlobDetailSchema, description: "PRD blob details require schemaVersion 3 and prototype blob details require schemaVersion 1; enforced by the runtime Zod contract." },
  { label: "ArtifactCreation.currentVersion", schema: artifactSchemas.artifactCreationSchema, description: "The created image Artifact current pointer and returned ready blob-backed ArtifactVersion are the same immutable version; enforced by the runtime Zod contract." },
  { label: "ArtifactVersionPreference.persistenceState", schema: artifactSchemas.artifactVersionPreferenceSchema, description: "Only the virtual revision 0 default omits persistence timestamps; stored preferences have positive revisions and timestamps." },
  { label: "ArtifactVersionFavoriteListItem.screenTarget", schema: artifactSchemas.artifactVersionFavoriteListItemSchema, description: "Prototype favourites identify one screen while non-Prototype favourites cannot expose a screen target." },
  { label: "BoardNodes.siblingOrder", schema: boardSchemas.boardNodesSchema, description: "Board sibling orders are unique within each parent scope; enforced by the runtime Zod contract and database indexes." },
  { label: "ArtifactVersionListItem.schemaVersion", schema: artifactSchemas.artifactVersionListItemSchema, description: "PRD list items require schemaVersion 3 and prototype list items use schemaVersion 1 or inline schemaVersion 2; enforced by the runtime Zod contract." },
  { label: "DesignSystemDocument.semanticGraph", schema: designSystemSchemas.designSystemDocumentSchema, description: "Design System ids and token paths are unique, references resolve, literals are typed, and token aliases are type-preserving and acyclic." },
  { label: "PublicDesignSystemDocument.semanticGraph", schema: designSystemSchemas.publicDesignSystemDocumentSchema, description: "Public Design System projections preserve the same semantic graph after private Blob identities are removed." },
  { label: "DesignPresetCatalog.uniqueVersionPair", schema: designPresetSchemas.designPresetCatalogSchema, description: "Authoritative Design preset id and version pairs are unique; enforced by the runtime Zod contract." },
  { label: "ProjectBootstrap.referentialIntegrity", schema: bootstrapSchemas.projectBootstrapSchema, description: "Selected Thread, entries, and latest Run are referentially consistent; enforced by the runtime Zod contract." },
  { label: "ArtifactCitationLocator.lineOrder", schema: citationSchemas.artifactCitationLocatorSchema, description: "When both lines are present, endLine is not before startLine; enforced by the runtime Zod contract." },
  { label: "FileExtraction.lifecycle", schema: fileSchemas.fileExtractionSchema, description: "Extraction status, timestamps, digest, and failure obey the lifecycle invariant; enforced by the runtime Zod contract." },
  { label: "FileAsset.lifecycle", schema: fileSchemas.fileAssetSchema, description: "File lifecycle and extraction pointers are internally consistent; enforced by the runtime Zod contract." },
  { label: "ImportSource.lifecycle", schema: importSourceSchemas.importSourceSchema, description: "Import source kind, frozen descriptor, checksum, failure and soft-delete timestamps agree; enforced by the runtime Zod contract." },
  { label: "RunSourceSnapshot.integrity", schema: importSourceSchemas.runSourceSnapshotSchema, description: "Run source snapshots preserve one source kind and immutable descriptor per position; enforced by the runtime Zod contract." },
  { label: "ImportSourceUrl.transport", schema: importSourceSchemas.importSourceUrlSchema, description: "Import source locators use HTTP(S); DNS, redirect and private-network checks are enforced by the Import Worker before fetching." },
  { label: "RunSourceIds.unique", schema: importSourceSchemas.runSourceIdsSchema, description: "A Run references each immutable Import Source at most once." },
  { label: "SubmissionIntent.clientFingerprint", schema: fileSchemas.submissionIntentClientFingerprintSchema, description: "SubmissionIntent upload slot fingerprints are bounded opaque values without control characters; they are independent from multipart checkpoint fingerprints." },
  { label: "ExportCapability.state", schema: exportSchemas.exportCapabilitySchema, description: "Export capability availability, authentication state, and stable reason codes remain mutually consistent; enforced by the runtime Zod contract." },
  { label: "ExportJob.lifecycle", schema: exportSchemas.exportJobSchema, description: "Export timestamps, output, and failure fields match the durable lifecycle state; enforced by the runtime Zod contract." },
  { label: "CreateExportJobRequest.figmaOptions", schema: exportSchemas.createExportJobRequestSchema, description: "Figma Export uses the fixed versioned Workbench Importer contract and does not accept client-controlled converter options." },
  { label: "CreateProjectPreviewRequest.initialScreen", schema: previewSchemas.createProjectPreviewRequestSchema, description: "Project Preview keeps initial-screen intent separate from single-screen Export cropping, and only Artifact selections can name an initial screen." },
  { label: "ExportBoardNodeIds.canonicalOrder", schema: exportSchemas.exportBoardNodeIdsSchema, description: "Board node ids are unique and in canonical ascending order; enforced by the runtime Zod contract and database constraint." },
  { label: "KnowledgeToolResponse.orderedItems", schema: knowledgeSchemas.knowledgeToolResponseSchema, description: "Knowledge result ranks are contiguous in response order and citation ids are unique; enforced by the runtime Zod contract." },
  { label: "KnowledgeToolDescriptor.safeEndpoint", schema: knowledgeSchemas.knowledgeToolDescriptorSchema.shape.endpoint, description: "Knowledge tool endpoints use HTTP(S) without userinfo or fragments; enforced by the runtime Zod contract." },
  { label: "ProjectInvitation.lifecycle", schema: invitationSchemas.projectInvitationSchema, description: "Invitation status, accepting principal, and lifecycle timestamps agree; enforced by the runtime Zod contract and database constraints." },
  { label: "ProjectInvitationListItem.tokenExposure", schema: invitationSchemas.projectInvitationListItemSchema, description: "Only pending invitations expose their reproducible acceptance token to an authorized Project owner." },
  { label: "SignedUploadHeaders.credentials", schema: fileSchemas.signedHeadersSchema, description: "Ambient credential headers are forbidden; enforced by the runtime Zod contract." },
  { label: "SignedUploadUrl.transport", schema: fileSchemas.signedUploadUrlSchema, description: "HTTPS is required except for loopback HTTP; userinfo and fragments are forbidden; enforced by the runtime Zod contract." },
  { label: "ListUploadParts.order", schema: fileSchemas.listUploadPartsResponseSchema, description: "Multipart part numbers are unique and strictly ascending; enforced by the runtime Zod contract." },
  { label: "CompleteFileUpload.order", schema: fileSchemas.completeFileUploadRequestSchema, description: "Multipart part numbers are unique and strictly ascending; enforced by the runtime Zod contract." },
  { label: "PrdInlineMarks.unique", schema: prdSchemas.prdInlineMarksSchema, description: "Inline marks are unique; enforced by the runtime Zod contract." },
  { label: "PrdDocumentV3.templateAndSemanticGraph", schema: prdSchemas.prdDocumentV3Schema, description: "PRD v3 uses contiguous function-specific sections, optional typed diagrams, embedded or later acceptance, and the same complete safety, table, citation and semantic-reference validation." },
  { label: "UpdateProject.nonEmpty", schema: projectSchemas.updateProjectRequestSchema, description: "At least one mutable Project field is required; enforced by the runtime Zod contract." },
  { label: "ProjectReleaseBoardNode.artifactReference", schema: releaseSchemas.projectReleaseBoardNodeSchema, description: "A release Board node pins both artifact and version ids or neither; enforced by the runtime Zod contract." },
  { label: "ProjectReleaseBoardSnapshot.graph", schema: releaseSchemas.projectReleaseBoardSnapshotSchema, description: "Release Board node and edge ids are unique and every edge endpoint exists; enforced by the runtime Zod contract." },
  { label: "ProjectReleaseArtifactAssetPins.order", schema: releaseSchemas.projectReleaseArtifactAssetPinsSchema, description: "Release Artifact binary asset pins are unique and strictly ordered by assetId; enforced by the runtime Zod contract." },
  { label: "ProjectReleaseArtifactPins.order", schema: releaseSchemas.projectReleaseArtifactPinsSchema, description: "Release artifact pins are unique and use contiguous manifest positions; enforced by the runtime Zod contract." },
  { label: "PublicProjectReleaseArtifactPins.order", schema: releaseSchemas.publicProjectReleaseArtifactPinsSchema, description: "Public Release artifact pins are unique and use contiguous manifest positions while omitting internal Blob identities." },
  { label: "ProjectRelease.integrity", schema: releaseSchemas.projectReleaseSchema, description: "Release lifecycle, Board snapshot, artifact pins, and manifest references agree; canonical digest equality is revalidated by the API." },
  { label: "PublicProjectRelease.integrity", schema: releaseSchemas.publicProjectReleaseSchema, description: "Public release lifecycle, Board snapshot, artifact pins, and manifest references agree without exposing creator principal ids." },
  { label: "PrototypeState.values.maxProperties", schema: prototypeSchemas.prototypeStateSchema.shape.values, description: "A Prototype state defines at most 200 explicitly named runtime values; enforced by the runtime Zod contract." },
  { label: "PrototypeStateOverride.nonEmpty", schema: prototypeSchemas.prototypeStateOverrideSchema, description: "A state override changes at least one property in addition to nodeId; enforced by the runtime Zod contract." },
  { label: "PrototypeExpression.boundedTree", schema: prototypeSchemas.prototypeExpressionSchema, description: "Prototype expressions use only the declared operators, at most eight levels and 64 total nodes, and one to sixteen operands per and/or. A bounded pre-parse walk enforces tree limits before structural parsing; variable references and operand/result types are checked by the Prototype document contract." },
  { label: "PrototypeOpenUrl.safeScheme", schema: prototypeSchemas.prototypeOpenUrlSchema, description: "Prototype external navigation is restricted to canonical HTTP(S), mailto, and tel URLs; stricter mail recipient, query, and telephone syntax is enforced by the runtime Zod contract." },
  { label: "RevisePrototypeRevision.feedbackIds", schema: visualPrototypeSchemas.revisePrototypeRevisionRequestSchema.shape.feedbackIds, description: "Feedback ids must be unique and all belong to the selected source revision. Uniqueness is enforced by Zod; ownership and open status are enforced in the transaction." },
  { label: "PrototypeDocument.semanticGraph", schema: prototypeSchemas.prototypeDocumentSchema, description: "Prototype screens, nodes, states, actions, bindings, assets, tokens, and motions form a valid semantic graph; enforced by the runtime Zod contract." },
  { label: "PublicPrototypeDocument.semanticGraph", schema: prototypeSchemas.publicPrototypeDocumentSchema, description: "Public Prototype projections preserve the same semantic graph after private Blob identities are removed." },
  { label: "PrototypePatchBatch.revision", schema: prototypePatchSchemas.prototypePatchBatchSchema, description: "Prototype patch transport revisions advance by exactly one and remain safe non-negative integers." },
  { label: "PrototypePatchEventPayload.revision", schema: prototypePatchSchemas.prototypePatchEventPayloadSchema, description: "Published Prototype patch events preserve the same exact one-step screen revision transition." },
  { label: "PrototypePatchDegradedEventPayload.revision", schema: prototypePatchSchemas.prototypePatchDegradedEventPayloadSchema, description: "Degraded Prototype patch events preserve the rejected one-step screen revision transition for recovery and audit." },
  { label: "RuntimePrototypePatchInput.revision", schema: prototypePatchSchemas.runtimePrototypePatchInputSchema, description: "Runtime Prototype patch inputs advance one screen transport revision without accepting caller-controlled source or scope identities." },
  { label: "Run.sources", schema: runSchemas.runSchema, description: "Run Import Source snapshots belong to the Run and Project, preserve immutable manifests, and use contiguous request positions; enforced by the runtime Zod contract." },
  { label: "RunArtifactDraft.screens", schema: runSchemas.artifactDraftCreatedEventSchema.shape.payload, description: "Prototype draft events contain at least one uniquely identified screen, while every non-Prototype draft event contains no screens." },
  { label: "RunPrototypePatchCheckpoint.screens", schema: runSchemas.runPrototypePatchCheckpointSchema, description: "Checkpoint screen revisions are unique and refer to screens in the authoritative Prototype document." },
  { label: "StartRun.artifactTargets", schema: runSchemas.runArtifactTargetsSchema, description: "Artifact targets preserve original request order, contain one immutable selection per Artifact and ArtifactVersion, and select at most twelve versions or screens; enforced by the runtime Zod contract." },
  { label: "StartRun.artifactTarget.screenIds", schema: runSchemas.runArtifactTargetSchema.shape.screenIds, description: "Screen ids within one Artifact target are unique; enforced by the runtime Zod contract." },
  { label: "StartRun.workflowInputs", schema: runSchemas.startRunRequestSchema, description: "Redesign requires a ready Import Source; Edit requires an Artifact target; Generate accepts explicit non-empty screen targets only when prototype is requested; Redesign and Ideate forbid targets. Enforced by the runtime Zod contract." },
  { label: "SubmitApproval.value", schema: runSchemas.submitApprovalRequestSchema, description: "A submit decision requires a value; enforced by the runtime Zod contract." },
  { label: "RuntimeModelList.uniqueIds", schema: runtimeModelSchemas.runtimeModelListSchema, description: "Runtime model ids are unique; enforced by the runtime Zod contract." },
  { label: "RuntimeModel.supportedWorkflows", schema: runtimeModelSchemas.runtimeModelSupportedWorkflowsSchema, description: "Each runtime model declares a non-empty set of unique Workbench workflows; enforced by the runtime Zod contract and Run admission policy." },
  { label: "ShareGrant.lifecycle", schema: shareSchemas.shareGrantSchema, description: "Share status and revocation timestamps agree; enforced by the runtime Zod contract." },
  { label: "SubmissionIntentRunRequest.workflowInputs", schema: submissionIntentSchemas.submissionIntentRunRequestSchema, description: "SubmissionIntent requests directly enforce the same workflow, Artifact target, requested output, and pre-submission Canvas scope semantics as StartRun." },
  { label: "CreateSubmissionIntent.request", schema: submissionIntentSchemas.createSubmissionIntentRequestSchema, description: "SubmissionIntent attachment sources are unique, Redesign has a durable source slot, and workflow target semantics directly share the live Run refinement without duplicate validation issues." },
  { label: "SubmissionIntent.lifecycle", schema: submissionIntentSchemas.submissionIntentSchema, description: "SubmissionIntent request target semantics, attachment positions, and submitted/cancelled lifecycle fields agree; enforced by runtime contracts and database constraints." },
  { label: "ThreadEntry.envelope", schema: threadSchemas.threadEntrySchema, description: "Entry role and kind match the versioned content variant; enforced by the runtime Zod contract." },
  { label: "RuntimeArtifactDraft.citations", schema: runtimeSchemas.runtimeArtifactDraftSchema, description: "A PRD draft uses protocol v3 and schemaVersion 3, and its title and top-level citations exactly match its content; enforced by the runtime Zod contract." },
  { label: "RuntimeResult.revisions", schema: runtimeSchemas.runtimeResultSchema, description: "A Runtime result revises each target Artifact at most once; enforced by the runtime Zod contract." },
  { label: "RuntimeExecuteJob.approvalIds", schema: queueSchemas.runtimeExecuteJobSchema, description: "Runtime execution approval ids are unique; enforced by the runtime Zod contract." },
  { label: "CanvasAgent.id", schema: canvasAgentSchemas.canvasAgentIdSchema, description: "Canvas entity ids are bounded opaque identifiers and cannot be URI schemes; enforced by the runtime Zod contract." },
  { label: "CanvasClientSession.id", schema: canvasAgentSchemas.canvasClientSessionIdSchema, description: "Canvas browser session ids are bounded opaque identifiers and cannot be URI schemes; enforced by the runtime Zod contract." },
  { label: "CanvasToolCall.id", schema: canvasAgentSchemas.canvasToolCallIdSchema, description: "Runtime Canvas tool call ids are bounded header-safe opaque identifiers and cannot be URI schemes; enforced by the runtime Zod contract." },
  { label: "CanvasClientCommand.scope", schema: canvasAgentSchemas.canvasClientCommandSchema, description: "Canvas client commands use one discriminated, time-bounded command contract with exact tool and target shapes." },
  { label: "CanvasAgentToolProfile.capabilities", schema: canvasAgentSchemas.canvasAgentToolProfileSchema, description: "Canvas tool profiles contain unique capability requirements; enforced by the runtime Zod contract." },
  { label: "CanvasSnapshot.integrity", schema: canvasAgentSchemas.canvasSnapshotSchema, description: "Canvas snapshots use unique screen references and only expose references declared by the snapshot; enforced by the runtime Zod contract." },
  { label: "CanvasClientStateSync.integrity", schema: canvasAgentSchemas.canvasClientStateSyncRequestSchema, description: "Canvas client-state synchronization uses unique visible and selected screen references bound to one browser project session." },
  { label: "CanvasAgentToolContext.integrity", schema: canvasAgentSchemas.canvasAgentToolContextSchema, description: "Canvas tool context requires a Run whenever a runtime attempt is present and forbids duplicate capabilities." },
  { label: "CanvasAgentToolDeclarationContext.integrity", schema: canvasAgentSchemas.canvasAgentToolDeclarationContextSchema, description: "Canvas tool declaration context forbids duplicate capabilities and inconsistent editable selections." },
  { label: "CanvasToolDescriptor.endpoint", schema: canvasAgentSchemas.canvasAgentToolDescriptorSchema.shape.endpoint, description: "Canvas capability endpoints are restricted to safe HTTP(S) URLs without credentials or fragments." },
  { label: "CanvasToolDescriptor.visualEndpoint", schema: canvasAgentSchemas.canvasAgentToolDescriptorSchema.shape.visualEndpoint, description: "Canvas visual capture endpoints are restricted to safe HTTP(S) URLs without credentials, query strings, or fragments." },
  { label: "CanvasToolReference.integrity", schema: canvasAgentSchemas.canvasAgentToolReferenceSchema, description: "Declared Canvas tools are unique and remain in canonical tool order." },
  { label: "CanvasToolInvocation.input", schema: canvasAgentSchemas.canvasAgentToolInvocationSchema, description: "Minimal Canvas invocations validate input against the selected tool schema; scope is reconstructed from the capability grant." },
  { label: "CanvasToolResult.integrity", schema: canvasAgentSchemas.canvasAgentToolResultSchema, description: "Canvas tool results preserve status-specific payload shape and output validation." },
  { label: "CanvasCommandExchange.integrity", schema: canvasAgentSchemas.canvasClientCommandExchangeSchema, description: "Canvas command ACKs must match the originating command scope, revision fence, and lifetime." },
  { label: "CanvasCommandAckRequest.visualCapture", schema: canvasAgentSchemas.canvasClientCommandAckRequestSchema, description: "Wire-only Canvas ACKs require a command-bound visual capture for view_screen and never persist the capture payload in the durable ACK." },
  { label: "CanvasCommandList.integrity", schema: canvasAgentSchemas.canvasClientCommandListSchema, description: "Pending Canvas command pages contain unique command ids." },
  { label: "CanvasSelection.integrity", schema: canvasAgentSchemas.canvasSelectionSchema, description: "Canvas selection kind matches its item count and screen references are unique." },
  { label: "CanvasSelectScreenInput.targets", schema: canvasAgentSchemas.canvasSelectScreenInputSchema, description: "Canvas selection targets are unique screen references; enforced by the runtime Zod contract." },
  { label: "SourcePrototype.path", schema: sourcePrototypeSchemas.sourcePrototypePathSchema, description: "Source prototype paths are bounded relative paths with an allowed source extension and no traversal segments." },
  { label: "SourcePrototype.file.bytes", schema: sourcePrototypeSchemas.sourcePrototypeFileSchema.shape.content, description: "Source prototype files remain within the per-file UTF-8 byte limit." },
  { label: "SourcePrototype.input.integrity", schema: sourcePrototypeSchemas.sourcePrototypeInputSchema, description: "Source prototype entries, paths, page ids, routes, and aggregate source size form one bounded virtual project." },
  { label: "SourcePrototype.build.bytes", schema: sourcePrototypeSchemas.sourcePrototypeBuildSchema.shape.html, description: "Compiled source prototype HTML remains within the bounded UTF-8 preview size." },
  { label: "SourcePrototype.document.integrity", schema: sourcePrototypeSchemas.sourcePrototypeDocumentSchema, description: "Persisted source prototype documents retain the same bounded project integrity as their input." },
  { label: "CreateSourcePrototypeArtifact.title", schema: artifactSchemas.createSourcePrototypeArtifactRequestSchema, description: "The source prototype artifact title must equal the immutable source document title." },
  { label: "CreatePrototypeRevisionPlan.feedbackIds", schema: visualPrototypeSchemas.createPrototypeRevisionPlanRequestSchema, description: "Selected feedback ids are unique; transactional validation binds them to the exact source revision and editor permission." },
  { label: "PrototypeProgress.identity", schema: visualPrototypeSchemas.prototypeProgressSchema, description: "Snapshot Run and seed events must share project, request, thread and current attempt; seed cursors cannot exceed the authoritative Run cursor." },
  { label: "PrototypeRevision.pages", schema: visualPrototypeSchemas.prototypeRevisionSchema, description: "Visual Prototype revisions contain unique page ids and bounded per-page DOM fragments; the complete executable document is provided once as verified previewHtml." },
  { label: "PrototypeExport.lifecycle", schema: visualPrototypeSchemas.prototypeExportSchema, description: "Visual Prototype exports require an immutable artifact on success, failure details on failure, and no output on cancellation; enforced by the runtime V2 contract." },
];

function buildAuditRoots(catalog: readonly { name: string; schema: ZodTypeAny }[]) {
  const modules = [
    approvalSchemas, artifactSchemas, boardSchemas, bootstrapSchemas, citationSchemas,
    commonSchemas, designPresetSchemas, designSystemSchemas, exportSchemas, fileSchemas, identitySchemas, importSourceSchemas, invitationSchemas, knowledgeSchemas, prdSchemas, projectSchemas, prototypeSchemas, prototypePatchSchemas,
    queueSchemas, releaseSchemas, runSchemas, runtimeModelSchemas, runtimeSchemas,
    shareSchemas, sourcePrototypeSchemas, submissionIntentSchemas, systemSchemas, threadSchemas, visualPrototypeSchemas,
  ];
  const roots = [...catalog];
  for (const module of modules) roots.push(...schemasFrom(module));
  return roots;
}

function childSchemas(schema: ZodTypeAny): ZodTypeAny[] {
  const definition = (schema as unknown as { _def: Record<string, unknown> })._def;
  switch (typeName(schema)) {
    case "ZodObject":
      return Object.values(definition.shape as Record<string, ZodTypeAny>);
    case "ZodArray": return [definition.element as ZodTypeAny];
    case "ZodUnion":
    case "ZodDiscriminatedUnion": return definition.options as ZodTypeAny[];
    case "ZodIntersection": return [definition.left as ZodTypeAny, definition.right as ZodTypeAny];
    case "ZodRecord": return [definition.keyType as ZodTypeAny, definition.valueType as ZodTypeAny];
    case "ZodTuple": return [...(definition.items as ZodTypeAny[]), ...(definition.rest ? [definition.rest as ZodTypeAny] : [])];
    case "ZodLazy": return [(definition.getter as () => ZodTypeAny)()];
    case "ZodPipe": return [definition.in as ZodTypeAny, definition.out as ZodTypeAny];
    case "ZodDefault":
    case "ZodOptional":
    case "ZodNullable":
    case "ZodReadonly": return [definition.innerType as ZodTypeAny];
    default: return [];
  }
}

function nullableReferenceTargets(catalog: readonly { schema: ZodTypeAny }[]) {
  const targets = new Set<ZodTypeAny>();
  const visited = new Set<ZodTypeAny>();
  const visit = (schema: ZodTypeAny) => {
    if (visited.has(schema)) return;
    visited.add(schema);
    if (typeName(schema) === "ZodNullable") {
      const inner = (schema as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
      targets.add(inner);
    }
    childSchemas(schema).forEach(visit);
  };
  catalog.forEach(({ schema }) => visit(schema));
  return targets;
}

function assertNoInvalidNullableReferences(document: unknown) {
  const visit = (value: unknown, location: string) => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.allOf)) {
      const hasReference = record.allOf.some((entry) => Boolean(entry && typeof entry === "object" && "$ref" in entry));
      const hasNullableType = record.allOf.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const type = (entry as Record<string, unknown>).type;
        return Array.isArray(type) && type.includes("null");
      });
      if (hasReference && hasNullableType) {
        throw new Error(`Invalid OpenAPI 3.1 nullable $ref intersection at ${location}`);
      }
    }
    for (const [key, child] of Object.entries(record)) visit(child, `${location}/${key}`);
  };
  visit(document, "#");
}

function auditNonStructuralSchemas(catalog: readonly { name: string; schema: ZodTypeAny }[]) {
  const reviewedChecks = new Set<object>();
  for (const reviewed of reviewedCheckSchemas) {
    const effects = directCustomChecks(reviewed.schema);
    if (effects.length !== 1) {
      throw new Error(`${reviewed.label} expected exactly one reviewed custom check; found ${effects.length}`);
    }
    reviewedChecks.add(effects[0]!);
    applyOpenApiMetadata(reviewed.schema, { description: reviewed.description });
  }

  const discoveredChecks = new Set<object>();
  const discoveredLazy = new Set<ZodTypeAny>();
  const visited = new Set<ZodTypeAny>();
  const visit = (schema: ZodTypeAny) => {
    if (visited.has(schema)) return;
    visited.add(schema);
    directCustomChecks(schema).forEach(check => discoveredChecks.add(check));
    if (typeName(schema) === "ZodLazy") discoveredLazy.add(schema);
    childSchemas(schema).forEach(visit);
  };
  catalog.forEach(({ schema }) => visit(schema));

  const unreviewed = [...discoveredChecks].filter((effect) => !reviewedChecks.has(effect));
  const stale = [...reviewedChecks].filter((effect) => !discoveredChecks.has(effect));
  if (unreviewed.length || stale.length) {
    throw new Error(`Custom check audit failed: ${unreviewed.length} unreviewed, ${stale.length} stale allowlist entries`);
  }
  if (discoveredLazy.size !== 1 || !discoveredLazy.has(commonSchemas.jsonValueSchema)) {
    throw new Error(`ZodLazy audit failed: JsonValue must remain the only reviewed recursive schema (found ${discoveredLazy.size})`);
  }
}

function annotateOpenApiStructure() {
  assertJsonValueOverrideMatchesZod();
  applyOpenApiMetadata(commonSchemas.jsonValueSchema, {
    type: ["string", "number", "boolean", "null", "array", "object"],
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
      { type: "array", items: { $ref: "#/components/schemas/JsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/components/schemas/JsonValue" } },
    ],
    description: "Recursive JSON value. This is the sole audited ZodLazy OpenAPI override.",
  });

  applyOpenApiMetadata(fileSchemas.signedHeadersSchema, {
    propertyNames: {
      allOf: [
        { pattern: "^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$" },
        { not: { enum: ["authorization", "cookie", "proxy-authorization"] } },
      ],
    },
  });
  applyOpenApiMetadata(fileSchemas.signedUploadUrlSchema, {
    pattern: "^(?:[Hh][Tt][Tt][Pp][Ss]://|[Hh][Tt][Tt][Pp]://(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]+)?(?:[/?]|$))",
    not: {
      anyOf: [
        { pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#]*@" },
        { pattern: "#" },
      ],
    },
  });

  applyOpenApiMetadata(knowledgeSchemas.knowledgeToolDescriptorSchema.shape.endpoint, {
    pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
    not: {
      anyOf: [
        { pattern: "^[Hh][Tt][Tt][Pp][Ss]?://[^/?#]*@" },
        { pattern: "#" },
      ],
    },
  });

  const listedParts = unwrapToObject(fileSchemas.listUploadPartsResponseSchema).shape.parts;
  applyOpenApiMetadata(listedParts, {
    uniqueItems: true,
    description: "Unique partNumber values in strictly ascending order",
  });
  const completionShape = unwrapToObject(fileSchemas.completeFileUploadRequestSchema).shape;
  applyOpenApiMetadata(completionShape.parts, {
    uniqueItems: true,
    description: "Provider ETags keyed by unique, strictly ascending partNumber values",
  });
  applyOpenApiMetadata(completionShape.sha256, {
    description: "Optional untrusted final client digest used only for early mismatch detection; trusted verification always reads stored object bytes",
  });

  applyOpenApiMetadata(prdSchemas.prdInlineMarksSchema, { uniqueItems: true });
  applyOpenApiMetadata(prototypeSchemas.prototypeStateOverrideSchema, { minProperties: 2 });
  applyOpenApiMetadata(prototypeSchemas.prototypeStateSchema.shape.values, { maxProperties: 200 });
  // Describe the bounded expression graph without repeatedly expanding every branch.
  // Describe these finite levels with references so each level is generated once.
  const expressionObject = (kind: string, properties: Record<string, unknown>) => ({
    type: "object",
    properties: { kind: { type: "string", enum: [kind] }, ...properties },
    required: ["kind", ...Object.keys(properties)],
    additionalProperties: false,
  });
  for (let depth = 1; depth <= prototypeSchemas.PROTOTYPE_EXPRESSION_MAX_DEPTH; depth += 1) {
    const child = { $ref: `#/components/schemas/PrototypeExpressionDepth${depth - 1}` };
    const oneOf = [
      expressionObject("literal", { value: { $ref: "#/components/schemas/PrototypeRuntimeValue" } }),
      expressionObject("variable", {
        path: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)*$", maxLength: 500 },
      }),
      ...(depth === 1 ? [] : [
        expressionObject("contains", { left: child, right: child }),
        expressionObject("equals", { left: child, right: child }),
        expressionObject("and", { operands: { type: "array", items: child, minItems: 1, maxItems: prototypeSchemas.PROTOTYPE_EXPRESSION_MAX_OPERANDS } }),
        expressionObject("or", { operands: { type: "array", items: child, minItems: 1, maxItems: prototypeSchemas.PROTOTYPE_EXPRESSION_MAX_OPERANDS } }),
        expressionObject("not", { operand: child }),
      ]),
    ];
    const schema = (prototypeSchemas as unknown as Record<string, ZodTypeAny>)[`prototypeExpressionDepth${depth}Schema`]!;
    applyOpenApiMetadata(schema, { type: "object", oneOf });
  }
  applyOpenApiMetadata(prototypeSchemas.prototypeExpressionSchema, {
    type: "object",
    allOf: [{ $ref: `#/components/schemas/PrototypeExpressionDepth${prototypeSchemas.PROTOTYPE_EXPRESSION_MAX_DEPTH}` }],
  });

  const runShape = unwrapToObject(runSchemas.runSchema).shape;
  applyOpenApiMetadata(runShape.sources, {
    description: "Immutable Import Source snapshots ordered by contiguous zero-based position",
  });
  const startRunShape = unwrapToObject(runSchemas.startRunRequestSchema).shape;
  applyOpenApiMetadata(startRunShape.sourceIds, { uniqueItems: true, description: "Unique ready Import Source ids resolved before Run creation" });
  applyOpenApiMetadata(runSchemas.runArtifactTargetSchema.shape.screenIds, {
    uniqueItems: true,
  });
  applyOpenApiMetadata(startRunShape.artifactTargets, {
    description: "Immutable ready ArtifactVersion selections in runtime target order; Generate Prototype requires one or more explicit screen ids on every source target",
  });
  applyOpenApiMetadata(runShape.artifactTargets, {
    description: "Immutable ready ArtifactVersion selections in original request order, including explicit Generate Prototype source screens",
  });
  applyOpenApiMetadata(runtimeModelSchemas.runtimeModelSupportedWorkflowsSchema, {
    uniqueItems: true,
    description: "Unique Workbench workflows accepted for this runtime model",
  });
  applyOpenApiMetadata(exportSchemas.exportBoardNodeIdsSchema, {
    uniqueItems: true,
    description: "Unique Board node ids in canonical ascending identifier order",
  });
}

function annotateStringChecks(catalog: readonly { schema: ZodTypeAny }[]) {
  const visited = new Set<ZodTypeAny>();
  const visit = (schema: ZodTypeAny) => {
    if (visited.has(schema)) return;
    visited.add(schema);
    if (typeName(schema) === "ZodString") {
      const definition = schema._zod.def as unknown as {
        checks?: { _zod: { def: { format?: string; pattern?: RegExp } } }[];
      };
      const checks = (definition.checks ?? []).map((check) => check._zod.def);
      const regex = checks.find((check) => check.format === "regex")?.pattern;
      // zod-to-openapi 9.1 serializes /pattern/u as "pattern/u". OpenAPI
      // patterns use the expression source without JavaScript delimiters.
      if (regex) applyOpenApiMetadata(schema, { pattern: regex.source });
      if (checks.some((check) => check.format === "url")) {
        applyOpenApiMetadata(schema, { format: "uri" });
      }
    }
    childSchemas(schema).forEach(visit);
  };
  catalog.forEach(({ schema }) => visit(schema));
}

function assertJsonValueOverrideMatchesZod() {
  const definition = (commonSchemas.jsonValueSchema as unknown as {
    _def: { getter: () => ZodTypeAny };
  })._def;
  const options = unionOptions(definition.getter());
  const expectedTypes = ["ZodString", "ZodNumber", "ZodBoolean", "ZodNull", "ZodArray", "ZodRecord"];
  const actualTypes = options.map(typeName);
  if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
    throw new Error(`JsonValue OpenAPI override is stale: expected ${expectedTypes.join(", ")}; found ${actualTypes.join(", ")}`);
  }
  const arrayItem = (options[4] as unknown as { _def: { element: ZodTypeAny } })._def.element;
  const recordValue = (options[5] as unknown as { _def: { valueType: ZodTypeAny } })._def.valueType;
  if (arrayItem !== commonSchemas.jsonValueSchema || recordValue !== commonSchemas.jsonValueSchema) {
    throw new Error("JsonValue array and object branches must recurse through JsonValue");
  }
}

function responseHeaders(names: readonly string[] | undefined) {
  const refs: Record<string, { $ref: string } | { schema: Record<string, unknown> }> = {};
  for (const name of names ?? []) {
    if (name === "contentDisposition") refs["Content-Disposition"] = { schema: { type: "string" } };
    if (name === "etag") refs.ETag = { $ref: "#/components/headers/ETag" };
    if (name === "fileRevisionEtag") refs.ETag = { $ref: "#/components/headers/FileRevisionETag" };
    if (name === "uploadRevisionEtag") refs.ETag = { $ref: "#/components/headers/UploadRevisionETag" };
    if (name === "contentDigestEtag") refs.ETag = { $ref: "#/components/headers/ContentDigestETag" };
    if (name === "canvasVisualSha256") refs["X-Content-SHA256"] = { schema: { type: "string", pattern: "^[0-9a-f]{64}$" } };
    if (name === "canvasVisualExpiresAt") refs["X-Canvas-Visual-Expires-At"] = { schema: { type: "string", format: "date-time" } };
    if (name === "location") refs.Location = { schema: { type: "string" } };
  }
  return refs;
}

function buildResponse(config: WorkbenchRouteResponse, registeredSchemas: ReadonlyMap<string, ZodTypeAny>) {
  const headers: Record<string, unknown> = responseHeaders(config.headers);
  if (config.byteRange) {
    headers["Accept-Ranges"] = { schema: { type: "string", const: "bytes" } };
    headers["Content-Length"] = { schema: { $ref: "#/components/schemas/SafeInteger" } };
    if (config.byteRange === "partial") {
      headers["Content-Range"] = { schema: { type: "string", pattern: "^bytes [0-9]+-[0-9]+/[0-9]+$" } };
    }
  }

  const mediaType = config.mediaType ?? (config.schema ? "application/json" : undefined);
  const schema = config.schema ? registeredSchema(config.schema, registeredSchemas)
    : mediaType === "application/octet-stream" ? { type: "string", format: "binary" }
      : mediaType === "text/event-stream" ? { type: "string" }
        : mediaType === "text/html" ? { type: "string" }
        : undefined;
  return {
    description: config.description,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(mediaType && schema ? { content: { [mediaType]: { schema } } } : {}),
  } as RouteConfig["responses"][string];
}

function registeredSchema(named: NamedWorkbenchSchema, registeredSchemas: ReadonlyMap<string, ZodTypeAny>) {
  const schema = registeredSchemas.get(named.name);
  if (!schema) throw new Error(`Route references unregistered schema ${named.name}`);
  return schema;
}

export function buildWorkbenchOpenApiDocument() {
  const catalog = buildSchemaCatalog();
  annotateStringChecks(buildAuditRoots(catalog));
  // Keep reviewed descriptions ahead of structural annotations so unchanged
  // authoring references retain their pinned bytes across generator upgrades.
  auditNonStructuralSchemas(buildAuditRoots(catalog));
  annotateOpenApiStructure();

  const registry = new OpenAPIRegistry();
  const registeredSchemas = new Map<string, ZodTypeAny>();
  const taggedOriginals = new Set<ZodTypeAny>();
  const nullableTargets = nullableReferenceTargets(catalog);
  for (const { name, schema } of catalog) {
    const registered = registry.register(name, schema);
    registeredSchemas.set(name, registered);
    if (!nullableTargets.has(schema) && !taggedOriginals.has(schema)) {
      taggedOriginals.add(schema);
      zodToOpenAPIRegistry.add(schema, zodToOpenAPIRegistry.get(registered)!);
    }
  }

  const parameterDefinitions = [
    ["WorkspaceId", commonSchemas.opaqueIdSchema, { name: "workspaceId", in: "path" }],
    ["ProjectId", commonSchemas.opaqueIdSchema, { name: "projectId", in: "path" }],
    ["PrincipalId", commonSchemas.opaqueIdSchema, { name: "principalId", in: "path" }],
    ["InvitationId", commonSchemas.opaqueIdSchema, { name: "invitationId", in: "path" }],
    ["PlanId", commonSchemas.opaqueIdSchema, { name: "planId", in: "path" }],
    ["PrototypeRevisionId", commonSchemas.opaqueIdSchema, { name: "revisionId", in: "path" }],
    ["PrototypeFeedbackId", commonSchemas.opaqueIdSchema, { name: "feedbackId", in: "path" }],
    ["PrototypeShareId", commonSchemas.opaqueIdSchema, { name: "shareId", in: "path" }],
    ["PrototypeExportId", commonSchemas.opaqueIdSchema, { name: "exportId", in: "path" }],
    ["PrototypeShareToken", z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/u), { name: "token", in: "path" }],
    ["KnowledgeProfileType", z.enum(["embedding", "retrieval"]), { name: "profileType", in: "path" }],
    ["KnowledgeProfileId", z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u), { name: "profileId", in: "path" }],
    ["ThreadId", commonSchemas.opaqueIdSchema, { name: "threadId", in: "path" }],
    ["SubmissionIntentId", commonSchemas.opaqueIdSchema, { name: "intentId", in: "path" }],
    ["RunId", commonSchemas.opaqueIdSchema, { name: "runId", in: "path" }],
    ["ArtifactId", commonSchemas.opaqueIdSchema, { name: "artifactId", in: "path" }],
    ["ArtifactVersionId", commonSchemas.opaqueIdSchema, { name: "artifactVersionId", in: "path" }],
    ["AssetId", commonSchemas.opaqueIdSchema, { name: "assetId", in: "path" }],
    ["FileId", commonSchemas.opaqueIdSchema, { name: "fileId", in: "path" }],
    ["ImportSourceId", commonSchemas.opaqueIdSchema, { name: "sourceId", in: "path" }],
    ["UploadSessionId", commonSchemas.opaqueIdSchema, { name: "uploadSessionId", in: "path" }],
    ["ApprovalId", commonSchemas.opaqueIdSchema, { name: "approvalId", in: "path" }],
    ["CommandId", canvasAgentSchemas.canvasAgentIdSchema, { name: "commandId", in: "path" }],
    ["VisualCapabilityId", canvasAgentSchemas.canvasAgentIdSchema, { name: "visualCapabilityId", in: "path" }],
    ["ReleaseId", commonSchemas.opaqueIdSchema, { name: "releaseId", in: "path" }],
    ["ShareId", commonSchemas.opaqueIdSchema, { name: "shareId", in: "path" }],
    ["ExportId", commonSchemas.opaqueIdSchema, { name: "exportId", in: "path" }],
    ["PreviewId", commonSchemas.opaqueIdSchema, { name: "previewId", in: "path" }],
    ["ShareToken", shareSchemas.shareTokenSchema, { name: "shareToken", in: "path" }],
    ["PartNumber", fileSchemas.uploadPartNumberSchema, { name: "partNumber", in: "path" }],
    ["ByteRange", z.string().regex(/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/).optional(), {
      name: "Range", in: "header", description: "A single RFC 9110 byte range; multipart ranges are deliberately unsupported",
    }],
    ["IfMatch", z.string().regex(/^"(?:0|[1-9][0-9]*)"$/), { name: "If-Match", in: "header" }],
    ["IfNoneMatch", z.string().min(3).max(160).optional(), { name: "If-None-Match", in: "header" }],
    ["IdempotencyKey", z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]{8,128}$/), { name: "Idempotency-Key", in: "header" }],
    ["LastEventId", z.string().optional(), { name: "Last-Event-ID", in: "header" }],
  ] as const;
  for (const [name, schema, param] of parameterDefinitions) {
    const tagged = (schema as ZodTypeAny & { openapi(value: OpenApiMetadata): ZodTypeAny }).openapi({ param });
    registry.registerParameter(name, tagged);
  }

  const entityTagRef = { $ref: "#/components/schemas/HttpEntityTag" };
  registry.registerComponent("headers", "ETag", {
    schema: entityTagRef,
    description: "Opaque strong validator enclosed in quotes; mutable resources currently use their numeric revision",
  });
  registry.registerComponent("headers", "FileRevisionETag", {
    schema: entityTagRef,
    description: "Strong numeric revision validator for the FileAsset represented by the response",
  });
  registry.registerComponent("headers", "UploadRevisionETag", {
    schema: entityTagRef,
    description: "Strong numeric revision validator for the FileUploadSession represented by the response",
  });
  registry.registerComponent("headers", "ContentDigestETag", {
    schema: entityTagRef,
    description: "Strong immutable validator derived from the verified content SHA-256",
  });
  registry.registerComponent("responses", "Problem", {
    description: "RFC 9457 problem details",
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
  });
  registry.registerComponent("responses", "RangeProblem", {
    description: "RFC 9457 unsatisfied byte range",
    headers: { "Content-Range": { schema: { type: "string", pattern: "^bytes \\*/[0-9]+$" } } },
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetails" } } },
  });
  registry.registerComponent("securitySchemes", "oidcBearer", {
    type: "http", scheme: "bearer", bearerFormat: "JWT",
  });
  registry.registerComponent("securitySchemes", "knowledgeGrant", {
    type: "http", scheme: "bearer", bearerFormat: "WBKG1",
    description: "Short-lived capability bound to one Workbench Run, Runtime attempt, Project, principal, and KnowledgeRelease",
  });
  registry.registerComponent("securitySchemes", "canvasGrant", {
    type: "http", scheme: "bearer", bearerFormat: "WBCT1",
    description: "Short-lived capability bound to one principal, Project, Thread, Run, Runtime attempt, Canvas Agent session, Board, and declared tool set",
  });

  const parameterRefs: Readonly<Record<string, { $ref: string }>> = {
    byteRange: { $ref: "#/components/parameters/ByteRange" },
    idempotencyKey: { $ref: "#/components/parameters/IdempotencyKey" },
    ifMatch: { $ref: "#/components/parameters/IfMatch" },
    ifNoneMatch: { $ref: "#/components/parameters/IfNoneMatch" },
    lastEventId: { $ref: "#/components/parameters/LastEventId" },
  };
  const pathParameterNames: Readonly<Record<string, string>> = {
    workspaceId: "WorkspaceId", projectId: "ProjectId", principalId: "PrincipalId", invitationId: "InvitationId",
    profileType: "KnowledgeProfileType", profileId: "KnowledgeProfileId",
    threadId: "ThreadId", intentId: "SubmissionIntentId", runId: "RunId",
    artifactId: "ArtifactId", artifactVersionId: "ArtifactVersionId", assetId: "AssetId", fileId: "FileId", sourceId: "ImportSourceId",
    uploadSessionId: "UploadSessionId", approvalId: "ApprovalId", partNumber: "PartNumber", commandId: "CommandId",
    releaseId: "ReleaseId", shareId: "ShareId", exportId: "ExportId", previewId: "PreviewId", visualCapabilityId: "VisualCapabilityId", shareToken: "ShareToken",
    planId: "PlanId", revisionId: "PrototypeRevisionId", feedbackId: "PrototypeFeedbackId", token: "PrototypeShareToken",
  };

  for (const route of workbenchHttpRoutes as readonly WorkbenchHttpRoute[]) {
    const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    const parameters = [
      ...placeholders.map((placeholder) => {
        const component = pathParameterNames[placeholder];
        if (!component) throw new Error(`No path parameter schema for ${placeholder}`);
        return { $ref: `#/components/parameters/${component}` };
      }),
      ...(route.requestHeaders ?? []).map((header) => parameterRefs[header]),
    ];
    const responses: RouteConfig["responses"] = {};
    responses[String(route.response.status)] = buildResponse(route.response, registeredSchemas);
    for (const extra of route.additionalResponses ?? []) {
      responses[String(extra.status)] = buildResponse(extra, registeredSchemas);
    }
    for (const status of route.problemStatuses ?? []) responses[String(status)] = { $ref: "#/components/responses/Problem" };
    if (route.rangeProblem) responses["416"] = { $ref: "#/components/responses/RangeProblem" };

    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      summary: route.response.description,
      ...(route.capability === "knowledgeGrant"
        ? { security: [{ knowledgeGrant: [] }] }
        : route.capability === "canvasGrant"
          ? { security: [{ canvasGrant: [] }] }
        : route.public ? { security: [] } : {}),
      ...(parameters.length ? { parameters } : {}),
      request: {
        ...(route.query ? { query: route.query } : {}),
        ...(route.requestBody ? {
          body: {
            required: true,
            content: { "application/json": { schema: registeredSchema(route.requestBody, registeredSchemas) } },
          },
        } : {}),
      },
      responses,
    });
  }

  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "产品工作台 API",
      version: "1.0.0",
      description: "Greenfield product contract. OpenAPI is the structural transport contract; Zod and domain validation remain the complete semantic contract. It does not expose the legacy conversation or AI SDK protocol.",
    },
    servers: [{ url: "/api/v1" }],
    security: [{ oidcBearer: [] }],
  });
  assertNoInvalidNullableReferences(document);
  return document;
}

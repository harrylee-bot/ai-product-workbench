import { z } from "zod";
import { artifactKindSchema } from "./artifacts.js";
import { boardNodeSchema, boardNodesSchema } from "./boards.js";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  opaqueIdSchema,
  revisionSchema,
} from "./common.js";
import { sha256Schema } from "./files.js";

export const projectReleaseProtocol = "workbench.project-release.v1" as const;

export const projectReleaseStatusSchema = z.enum(["building", "ready", "failed"]);

export const projectReleaseBoardNodeSchema = boardNodeSchema;

export const projectReleaseBoardEdgeSchema = z.object({
  id: opaqueIdSchema,
  sourceNodeId: opaqueIdSchema,
  targetNodeId: opaqueIdSchema,
  kind: z.string().min(1).max(80),
  data: z.record(jsonValueSchema),
}).strict();

export const projectReleaseBoardSnapshotSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  revision: revisionSchema,
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive(),
  }).strict(),
  nodes: boardNodesSchema,
  edges: z.array(projectReleaseBoardEdgeSchema),
}).strict().superRefine((board, context) => {
  const nodeIds = new Set<string>();
  const nodesById = new Map(board.nodes.map((node) => [node.id, node]));
  for (const [index, node] of board.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "id"],
        message: `Duplicate board node id: ${node.id}`,
      });
    }
    nodeIds.add(node.id);
    if (node.parentNodeId !== null) {
      const parent = nodesById.get(node.parentNodeId);
      if (!parent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "parentNodeId"],
          message: "Board node parent must exist in the same snapshot",
        });
      } else if (parent.kind !== "frame") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "parentNodeId"],
          message: "Board nodes may only be parented by a frame",
        });
      }
    }
  }

  for (const [index, node] of board.nodes.entries()) {
    const ancestors = new Set<string>([node.id]);
    let parentId = node.parentNodeId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", index, "parentNodeId"],
          message: "Board frame hierarchy must be acyclic",
        });
        break;
      }
      ancestors.add(parentId);
      parentId = nodesById.get(parentId)?.parentNodeId ?? null;
    }
  }

  const edgeIds = new Set<string>();
  for (const [index, edge] of board.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "id"],
        message: `Duplicate board edge id: ${edge.id}`,
      });
    }
    edgeIds.add(edge.id);

    if (!nodeIds.has(edge.sourceNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "sourceNodeId"],
        message: "Board snapshot edges must reference an existing source node",
      });
    }
    if (!nodeIds.has(edge.targetNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "targetNodeId"],
        message: "Board snapshot edges must reference an existing target node",
      });
    }
  }
});

export const projectReleaseArtifactAssetKindSchema = z.enum(["image", "font"]);

export const projectReleaseArtifactAssetPinSchema = z.object({
  assetId: opaqueIdSchema,
  kind: projectReleaseArtifactAssetKindSchema,
  blobId: opaqueIdSchema,
  mediaType: z.string().min(1).max(255),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  metadata: z.record(jsonValueSchema),
}).strict();

function refineArtifactAssetPins(
  pins: ReadonlyArray<{ assetId: string }>,
  context: z.RefinementCtx,
) {
  for (let index = 1; index < pins.length; index += 1) {
    if (pins[index - 1]!.assetId >= pins[index]!.assetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "assetId"],
        message: "Release Artifact asset pins must be unique and strictly ordered by assetId",
      });
    }
  }
}

export const projectReleaseArtifactAssetPinsSchema = z.array(projectReleaseArtifactAssetPinSchema)
  .max(2_000)
  .superRefine(refineArtifactAssetPins);

export const projectReleaseArtifactPinSchema = z.object({
  position: z.number().int().nonnegative(),
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  title: z.string().min(1).max(240),
  kind: artifactKindSchema,
  version: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  checksum: sha256Schema,
  assets: projectReleaseArtifactAssetPinsSchema,
}).strict();

function refineArtifactPins(
  pins: ReadonlyArray<{ position: number; artifactId: string; artifactVersionId: string }>,
  context: z.RefinementCtx,
) {
    const artifactIds = new Set<string>();
    const versionIds = new Set<string>();

    for (const [index, pin] of pins.entries()) {
      if (pin.position !== index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "position"],
          message: "Release artifact pins must use contiguous positions in manifest order",
        });
      }
      if (artifactIds.has(pin.artifactId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "artifactId"],
          message: `Duplicate release artifact id: ${pin.artifactId}`,
        });
      }
      if (versionIds.has(pin.artifactVersionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "artifactVersionId"],
          message: `Duplicate release artifact version id: ${pin.artifactVersionId}`,
        });
      }
      artifactIds.add(pin.artifactId);
      versionIds.add(pin.artifactVersionId);
    }
}

export const projectReleaseArtifactPinsSchema = z.array(projectReleaseArtifactPinSchema)
  .max(1_000)
  .superRefine(refineArtifactPins);

export const projectReleaseManifestSchema = z.object({
  protocol: z.literal(projectReleaseProtocol),
  projectId: opaqueIdSchema,
  releaseVersion: z.number().int().positive(),
  board: z.object({
    id: opaqueIdSchema,
    revision: revisionSchema,
    checksum: sha256Schema,
  }).strict(),
  artifacts: projectReleaseArtifactPinsSchema,
}).strict();

export const publicProjectReleaseArtifactPinSchema = projectReleaseArtifactPinSchema
  .omit({ assets: true });

export const publicProjectReleaseArtifactPinsSchema = z.array(publicProjectReleaseArtifactPinSchema)
  .max(1_000)
  .superRefine(refineArtifactPins);

export const publicProjectReleaseManifestSchema = projectReleaseManifestSchema.extend({
  artifacts: publicProjectReleaseArtifactPinsSchema,
}).strict();

export const projectReleaseFailureSchema = z.object({
  code: z.string().min(1).max(120),
  detail: z.string().max(4_000).nullable(),
}).strict();

const projectReleaseBaseSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  version: z.number().int().positive(),
  status: projectReleaseStatusSchema,
  createdById: opaqueIdSchema,
  boardId: opaqueIdSchema,
  boardRevision: revisionSchema,
  boardSnapshot: projectReleaseBoardSnapshotSchema,
  boardChecksum: sha256Schema,
  artifactPins: projectReleaseArtifactPinsSchema,
  manifest: projectReleaseManifestSchema,
  manifestSha256: sha256Schema,
  failure: projectReleaseFailureSchema.nullable(),
  createdAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
}).strict();

type ReleaseRefinementInput = {
  status: "building" | "ready" | "failed";
  finishedAt: string | null;
  failure: { code: string; detail: string | null } | null;
  boardId: string;
  projectId: string;
  boardRevision: number;
  version: number;
  boardChecksum: string;
  boardSnapshot: z.infer<typeof projectReleaseBoardSnapshotSchema>;
  artifactPins: ReadonlyArray<{ artifactId: string; artifactVersionId: string }>;
  manifest: {
    projectId: string;
    releaseVersion: number;
    board: { id: string; revision: number; checksum: string };
    artifacts: readonly unknown[];
  };
};

function refineProjectRelease(release: ReleaseRefinementInput, context: z.RefinementCtx) {
  if (release.status === "building" && (release.finishedAt !== null || release.failure !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Building releases cannot be finished or carry a failure",
    });
  }
  if (release.status === "ready" && (release.finishedAt === null || release.failure !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Ready releases require finishedAt and cannot carry a failure",
    });
  }
  if (release.status === "failed" && (release.finishedAt === null || release.failure === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Failed releases require finishedAt and failure details",
    });
  }

  const expectedBoard = {
    id: release.boardId,
    projectId: release.projectId,
    revision: release.boardRevision,
  };
  for (const [key, expected] of Object.entries(expectedBoard)) {
    if (release.boardSnapshot[key as keyof typeof expectedBoard] !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boardSnapshot", key],
        message: `Board snapshot ${key} must match its release field`,
      });
    }
  }

  if (release.manifest.projectId !== release.projectId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manifest", "projectId"],
      message: "Release manifest must belong to the release project",
    });
  }
  if (release.manifest.releaseVersion !== release.version) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manifest", "releaseVersion"],
      message: "Release manifest version must match the release version",
    });
  }
  if (
    release.manifest.board.id !== release.boardId
    || release.manifest.board.revision !== release.boardRevision
    || release.manifest.board.checksum !== release.boardChecksum
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manifest", "board"],
      message: "Release manifest board reference must match the pinned board snapshot",
    });
  }

  if (release.manifest.artifacts.length !== release.artifactPins.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["manifest", "artifacts"],
      message: "Release manifest artifact pins must match the release pins",
    });
  } else {
    for (const [index, pin] of release.artifactPins.entries()) {
      const manifestPin = release.manifest.artifacts[index];
      if (JSON.stringify(manifestPin) !== JSON.stringify(pin)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["manifest", "artifacts", index],
          message: "Release manifest artifact pins must match the release pins",
        });
      }
    }
  }

  const pinnedVersions = new Map(
    release.artifactPins.map((pin) => [pin.artifactId, pin.artifactVersionId]),
  );
  for (const [index, node] of release.boardSnapshot.nodes.entries()) {
    if (
      node.artifactId !== null
      && pinnedVersions.get(node.artifactId) !== node.artifactVersionId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boardSnapshot", "nodes", index, "artifactVersionId"],
        message: "Board snapshot artifact nodes must reference versions pinned by the release",
      });
    }
  }
}

export const projectReleaseSchema = projectReleaseBaseSchema.superRefine(refineProjectRelease);

// Public share projections intentionally omit the creator principal id. The
// immutable manifest contains everything a preview or remix client needs.
export const publicProjectReleaseSchema = projectReleaseBaseSchema
  .omit({ createdById: true })
  .extend({
    status: z.literal("ready"),
    failure: z.null(),
    finishedAt: isoDateTimeSchema,
    artifactPins: publicProjectReleaseArtifactPinsSchema,
    manifest: publicProjectReleaseManifestSchema,
  })
  .superRefine(refineProjectRelease);

export const createProjectReleaseRequestSchema = z.object({
  boardId: opaqueIdSchema,
  boardRevision: revisionSchema,
}).strict();

export const projectReleaseListSchema = z.object({
  items: z.array(projectReleaseSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
}).strict();

export type ProjectReleaseStatus = z.infer<typeof projectReleaseStatusSchema>;
export type ProjectReleaseBoardSnapshot = z.infer<typeof projectReleaseBoardSnapshotSchema>;
export type ProjectReleaseArtifactPin = z.infer<typeof projectReleaseArtifactPinSchema>;
export type ProjectReleaseArtifactAssetPin = z.infer<typeof projectReleaseArtifactAssetPinSchema>;
export type ProjectReleaseManifest = z.infer<typeof projectReleaseManifestSchema>;
export type ProjectReleaseFailure = z.infer<typeof projectReleaseFailureSchema>;
export type ProjectRelease = z.infer<typeof projectReleaseSchema>;
export type PublicProjectRelease = z.infer<typeof publicProjectReleaseSchema>;
export type CreateProjectReleaseRequest = z.infer<typeof createProjectReleaseRequestSchema>;
export type ProjectReleaseList = z.infer<typeof projectReleaseListSchema>;

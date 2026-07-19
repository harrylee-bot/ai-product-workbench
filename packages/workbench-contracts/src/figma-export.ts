import { z } from "zod";
import { opaqueIdSchema } from "./common.js";
import { exportSelectionSchema } from "./exports.js";
import { sha256Schema } from "./files.js";
import { prototypeDocumentSchema } from "./prototype.js";

export const workbenchFigmaImporterVersion = "1.0.0" as const;

export const figmaExportAssetSchema = z.object({
  artifactVersionId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  kind: z.enum(["image", "font"]),
  mediaType: z.enum([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "font/woff",
    "font/woff2",
  ]),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
  archivePath: z.string().regex(/^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|woff|woff2)$/),
}).strict();

export const figmaExportPrototypeSchema = z.object({
  artifactId: opaqueIdSchema,
  artifactVersionId: opaqueIdSchema,
  title: z.string().min(1).max(240),
  version: z.number().int().positive(),
  checksum: sha256Schema,
  selectedScreenIds: z.array(opaqueIdSchema).min(1).max(500)
    .refine((ids) => new Set(ids).size === ids.length, "selectedScreenIds must be unique"),
  document: prototypeDocumentSchema,
}).strict();

export const figmaExportDocumentSchema = z.object({
  protocol: z.literal("workbench.figma-export.v1"),
  schemaVersion: z.literal(1),
  importer: z.object({
    minimumVersion: z.literal(workbenchFigmaImporterVersion),
    pluginName: z.literal("产品工作台 Importer"),
  }).strict(),
  release: z.object({
    id: opaqueIdSchema,
    projectId: opaqueIdSchema,
    version: z.number().int().positive(),
  }).strict(),
  selection: exportSelectionSchema,
  prototypes: z.array(figmaExportPrototypeSchema).min(1).max(500),
  assets: z.array(figmaExportAssetSchema).max(10_000),
}).strict().superRefine((document, context) => {
  const versionIds = new Set<string>();
  const expectedAssets = new Map<string, {
    kind: "image" | "font";
    mediaType: string;
    byteSize: number;
    sha256: string;
  }>();

  document.prototypes.forEach((prototype, prototypeIndex) => {
    if (versionIds.has(prototype.artifactVersionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prototypes", prototypeIndex, "artifactVersionId"],
        message: "Prototype ArtifactVersions must be unique",
      });
    }
    versionIds.add(prototype.artifactVersionId);

    const screenIds = new Set(prototype.document.screens.map((screen) => screen.id));
    prototype.selectedScreenIds.forEach((screenId, screenIndex) => {
      if (!screenIds.has(screenId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prototypes", prototypeIndex, "selectedScreenIds", screenIndex],
          message: `Unknown Prototype screen: ${screenId}`,
        });
      }
    });

    for (const asset of prototype.document.assets) {
      if (asset.kind === "icon") continue;
      expectedAssets.set(`${prototype.artifactVersionId}\u0000${asset.id}`, {
        kind: asset.kind,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
      });
    }
  });

  const actualAssets = new Set<string>();
  document.assets.forEach((asset, assetIndex) => {
    const key = `${asset.artifactVersionId}\u0000${asset.assetId}`;
    if (actualAssets.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets", assetIndex],
        message: "Figma Export asset identities must be unique",
      });
    }
    actualAssets.add(key);
    const expected = expectedAssets.get(key);
    if (!expected
      || expected.kind !== asset.kind
      || expected.mediaType !== asset.mediaType
      || expected.byteSize !== asset.byteSize
      || expected.sha256 !== asset.sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets", assetIndex],
        message: "Figma Export asset does not match its immutable Prototype asset pin",
      });
    }
    if (!asset.archivePath.startsWith(`assets/${asset.sha256}.`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets", assetIndex, "archivePath"],
        message: "Figma Export asset path must be content-addressed by sha256",
      });
    }
  });

  for (const key of expectedAssets.keys()) {
    if (actualAssets.has(key)) continue;
    const [artifactVersionId, assetId] = key.split("\u0000");
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assets"],
      message: `Missing Figma Export asset ${artifactVersionId}/${assetId}`,
    });
  }
});

export type FigmaExportAsset = z.infer<typeof figmaExportAssetSchema>;
export type FigmaExportPrototype = z.infer<typeof figmaExportPrototypeSchema>;
export type FigmaExportDocument = z.infer<typeof figmaExportDocumentSchema>;

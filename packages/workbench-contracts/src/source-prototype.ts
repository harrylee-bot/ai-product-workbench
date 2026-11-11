import { z } from "zod";
import { opaqueIdSchema } from "./common.js";

export const maximumSourcePrototypeFiles = 32;
export const maximumSourcePrototypeFileBytes = 128 * 1024;
export const maximumSourcePrototypeSourceBytes = 512 * 1024;
export const maximumSourcePrototypeHtmlBytes = 2 * 1024 * 1024;

export const sourcePrototypePathSchema = z.string().min(1).max(240)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*\.(?:tsx|jsx|ts|js|css|json)$/u)
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".." || part === "" || part === "node_modules"), "Source paths must stay inside the virtual project");

const utf8Length = (value: string) => new TextEncoder().encode(value).byteLength;
export const sourcePrototypeFileSchema = z.object({
  path: sourcePrototypePathSchema,
  content: z.string().max(maximumSourcePrototypeFileBytes)
    .refine((value) => utf8Length(value) <= maximumSourcePrototypeFileBytes, "Source file exceeds its UTF-8 byte budget"),
}).strict();

export const sourcePrototypePageSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(240),
  route: z.string().min(1).max(240).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/u),
}).strict();

const sourcePrototypeShape = {
  documentId: opaqueIdSchema,
  title: z.string().trim().min(1).max(240),
  revision: z.number().int().positive(),
  summary: z.string().trim().min(1).max(12_000),
  entryFile: sourcePrototypePathSchema,
  files: z.array(sourcePrototypeFileSchema).min(1).max(maximumSourcePrototypeFiles),
  pages: z.array(sourcePrototypePageSchema).min(1).max(12),
};

function refineSourceProject(value: {
  entryFile: string;
  files: Array<{ path: string; content: string }>;
  pages: Array<{ id: string; route: string }>;
}, context: z.RefinementCtx) {
  const paths = new Set<string>();
  let bytes = 0;
  value.files.forEach((file, index) => {
    const normalized = file.path.toLowerCase();
    if (paths.has(normalized)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "Source paths must be unique, including case" });
    paths.add(normalized);
    bytes += utf8Length(file.content);
  });
  if (!value.files.some((file) => file.path === value.entryFile)) context.addIssue({ code: "custom", path: ["entryFile"], message: "Entry file must exist in the virtual project" });
  if (!/\.(?:tsx|jsx|ts|js)$/u.test(value.entryFile)) context.addIssue({ code: "custom", path: ["entryFile"], message: "Entry must be a JavaScript or TypeScript component" });
  if (bytes > maximumSourcePrototypeSourceBytes) context.addIssue({ code: "custom", path: ["files"], message: "Source project exceeds its UTF-8 byte budget" });
  for (const key of ["id", "route"] as const) {
    if (new Set(value.pages.map((page) => page[key])).size !== value.pages.length) context.addIssue({ code: "custom", path: ["pages"], message: `Page ${key}s must be unique` });
  }
}

export const sourcePrototypeInputSchema = z.object({
  protocol: z.literal("workbench.prototype-source-input.v1"),
  ...sourcePrototypeShape,
}).strict().superRefine(refineSourceProject);

export const sourcePrototypeBuildSchema = z.object({
  renderer: z.literal("workbench.react-source.v1"),
  reactVersion: z.literal("19.2.3"),
  bundlerVersion: z.literal("0.28.1"),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  html: z.string().min(1).max(maximumSourcePrototypeHtmlBytes)
    .refine((value) => utf8Length(value) <= maximumSourcePrototypeHtmlBytes, "Compiled HTML exceeds its UTF-8 byte budget"),
  htmlSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const sourcePrototypeAssetManifestSchema = z.array(z.string()).max(0).default([]);

export const sourcePrototypeDocumentSchema = z.object({
  protocol: z.literal("workbench.prototype-source.v1"),
  ...sourcePrototypeShape,
  assets: sourcePrototypeAssetManifestSchema,
  build: sourcePrototypeBuildSchema,
}).strict().superRefine(refineSourceProject);

export const publicSourcePrototypeDocumentSchema = z.object({
  protocol: z.literal("workbench.prototype-source.v1"),
  documentId: sourcePrototypeShape.documentId,
  title: sourcePrototypeShape.title,
  revision: sourcePrototypeShape.revision,
  summary: sourcePrototypeShape.summary,
  entryFile: sourcePrototypeShape.entryFile,
  pages: sourcePrototypeShape.pages,
  assets: sourcePrototypeAssetManifestSchema,
  build: sourcePrototypeBuildSchema,
}).strict();

export type SourcePrototypeInput = z.infer<typeof sourcePrototypeInputSchema>;
export type SourcePrototypeDocument = z.infer<typeof sourcePrototypeDocumentSchema>;
export type PublicSourcePrototypeDocument = z.infer<typeof publicSourcePrototypeDocumentSchema>;

export function isSourcePrototypeDocument(value: unknown): value is SourcePrototypeDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as { protocol?: unknown }).protocol === "workbench.prototype-source.v1";
}

export function projectPublicSourcePrototypeDocument(value: SourcePrototypeDocument): PublicSourcePrototypeDocument {
  const { files: _files, ...publicDocument } = sourcePrototypeDocumentSchema.parse(value);
  return publicSourcePrototypeDocumentSchema.parse(publicDocument);
}

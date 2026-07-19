import {
  importSourceSchema,
  type ImportSource,
} from "@workbench/workbench-contracts";

export const importSourceSelect = {
  id: true,
  projectId: true,
  createdById: true,
  kind: true,
  status: true,
  label: true,
  descriptor: true,
  requestHash: true,
  checksum: true,
  revision: true,
  failureCode: true,
  failureDetail: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type ImportSourceRecord = {
  id: string;
  projectId: string;
  createdById: string;
  kind: ImportSource["kind"];
  status: ImportSource["status"];
  label: string;
  descriptor: unknown;
  requestHash: string;
  checksum: string | null;
  revision: number;
  failureCode: string | null;
  failureDetail: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function mapImportSource(source: ImportSourceRecord): ImportSource {
  return importSourceSchema.parse({
    id: source.id,
    projectId: source.projectId,
    createdById: source.createdById,
    kind: source.kind,
    status: source.status,
    label: source.label,
    descriptor: source.descriptor,
    checksum: source.checksum,
    revision: source.revision,
    failure: source.failureCode && source.failureDetail
      ? { code: source.failureCode, message: source.failureDetail }
      : null,
    deletedAt: source.deletedAt?.toISOString() ?? null,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  });
}

import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { type ArtifactVersionDetail, type PublicArtifactVersionDetail, exportPreviewTokenResponseSchema } from "@workbench/workbench-contracts";
import { notFoundProblem } from "../../common/problem-details.js";
import { WorkbenchDbService } from "../../platform/database/workbench-db.service.js";
import { ArtifactsService } from "../artifacts/artifacts.service.js";
import { SharesService } from "../shares/shares.service.js";
import { ExportPreviewConfig } from "../exports/export-preview.config.js";

@Injectable()
export class SourcePrototypePreviewService {
  constructor(
    private readonly db: WorkbenchDbService,
    private readonly artifacts: ArtifactsService,
    private readonly shares: SharesService,
    private readonly config: ExportPreviewConfig,
  ) {}

  async createPrivate(principalId: string, artifactId: string, versionId: string) {
    const { detail } = await this.artifacts.getVersion(principalId, artifactId, versionId);
    requireSource(detail);
    return formatCapability(this.config.createSourceCapability({
      artifactId, artifactVersionId: versionId, checksum: detail.checksum, principalId,
    }));
  }

  async createPublic(shareToken: string, artifactId: string, versionId: string) {
    const { detail } = await this.shares.getPublicArtifactVersion(shareToken, artifactId, versionId);
    requireSource(detail);
    const share = await this.db.shareGrant.findUnique({
      where: { tokenHash: createHash("sha256").update(shareToken, "utf8").digest("hex") },
      select: { id: true, revision: true, artifactVersionId: true, status: true, scope: true, expiresAt: true },
    });
    const now = new Date();
    if (!share || share.status !== "active" || share.scope !== "view" || share.artifactVersionId !== versionId
      || (share.expiresAt && share.expiresAt <= now)) throw notFoundProblem("Source prototype preview");
    return formatCapability(this.config.createSourceCapability({
      artifactId, artifactVersionId: versionId, checksum: detail.checksum,
      shareId: share.id, shareRevision: share.revision,
    }, now, share.expiresAt ?? undefined));
  }
}

function requireSource(detail: ArtifactVersionDetail | PublicArtifactVersionDetail) {
  if (detail.kind !== "prototype" || detail.schemaVersion !== 2 || detail.status !== "ready" || detail.contentMode !== "inline") {
    throw notFoundProblem("Ready source prototype");
  }
}

function formatCapability(capability: { url: string; expiresAt: Date }) {
  return exportPreviewTokenResponseSchema.parse({ url: capability.url, expiresAt: capability.expiresAt.toISOString() });
}

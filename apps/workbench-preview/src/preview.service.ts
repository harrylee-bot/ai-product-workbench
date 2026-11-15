import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { canonicalJson, prototypeDocumentSchema, sourcePrototypeDocumentSchema } from "@workbench/workbench-contracts";
import { renderPrototypeDocumentHtml } from "@workbench/workbench-export-core/html-renderer";
import type { ExportBinaryAsset } from "@workbench/workbench-export-core";
import type { PrismaClient } from "@workbench/workbench-db";
import { verifySourcePrototypePreviewToken, verifyPreviewToken } from "@workbench/workbench-preview-token";
import type { PreviewConfig } from "./config.js";
import { previewContentSecurityPolicy, previewContentSecurityPolicyFromHashes } from "./csp.js";
import { createWorkbenchPreviewBridgeInjection, WorkbenchPreviewHtmlInspector } from "./preview-bridge.js";
import type { PreviewStorage } from "./storage.js";

export class PreviewService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: PreviewStorage,
    private readonly config: Pick<PreviewConfig, "tokenSecret" | "tokenMaximumTtlSeconds" | "maximumHtmlBytes" | "webOrigin">,
  ) {}

  async resolve(token: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (token.startsWith("wbsp1.")) return this.resolveSourcePrototype(token, signal);
    const payload = verifyPreviewToken(token, this.config.tokenSecret, {
      maximumTtlSeconds: this.config.tokenMaximumTtlSeconds,
    });
    const now = new Date();
    const job = await this.db.exportJob.findFirst({
      where: {
        id: payload.exportJobId,
        format: "html",
        status: "succeeded",
        OR: [
          {
            purpose: "export",
            preview: null,
            release: { is: { project: { is: { status: "active" } } } },
          },
          {
            purpose: "preview",
            release: null,
            preview: {
              is: {
                expiresAt: { gt: now },
                project: { status: "active" },
              },
            },
          },
        ],
        outputBlobId: { not: null },
        outputBlob: { is: { status: "ready", deletedAt: null } },
      },
      select: {
        id: true,
        purpose: true,
        release: { select: { projectId: true } },
        preview: { select: { projectId: true } },
        outputBlob: {
          select: { storageKey: true, mediaType: true, byteSize: true, sha256: true },
        },
      },
    });
    const projectId = job?.purpose === "preview"
      ? job.preview?.projectId
      : job?.release?.projectId;
    const authorization = job && projectId
      ? await this.db.projectMember.findFirst({
          where: {
            projectId,
            principalId: payload.principalId,
            ...(job.purpose === "export"
              ? { role: { in: ["owner", "editor"] as ("owner" | "editor")[] } }
              : {}),
            principal: { status: "active" },
          },
          select: { projectId: true },
        })
      : null;
    const blob = job?.outputBlob;
    if (!job || !authorization || !blob || !/^text\/html(?:;\s*charset=utf-8)?$/i.test(blob.mediaType)) {
      throw new Error("PREVIEW_NOT_FOUND");
    }
    const byteSize = Number(blob.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error("PREVIEW_NOT_FOUND");
    if (byteSize > this.config.maximumHtmlBytes) throw new Error("PREVIEW_NOT_FOUND");
    return {
      capabilityToken: token,
      identity: {
        storageKey: blob.storageKey,
        mediaType: blob.mediaType,
        byteSize,
        sha256: blob.sha256,
      },
      etag: previewRepresentationEtag(blob.sha256, this.config.webOrigin, token),
    };
  }

  private async resolveSourcePrototype(token: string, signal?: AbortSignal) {
    const payload = verifySourcePrototypePreviewToken(token, this.config.tokenSecret, {
      maximumTtlSeconds: this.config.tokenMaximumTtlSeconds,
    });
    const now = new Date();
    const version = await this.db.artifactVersion.findFirst({
      where: {
        id: payload.artifactVersionId, artifactId: payload.artifactId, checksum: payload.checksum,
        status: "ready", schemaVersion: { in: [1, 2] }, contentBlobId: null,
        artifact: { kind: "prototype", project: { status: "active" } },
      },
      select: { projectId: true, schemaVersion: true, content: true, checksum: true,
        assets: { select: { assetId: true, kind: true, blobId: true, mediaType: true, byteSize: true, sha256: true,
          blob: { select: { storageKey: true, status: true, deletedAt: true, sha256: true, byteSize: true, mediaType: true } } } },
      },
    });
    if (!version) throw new Error("PREVIEW_NOT_FOUND");
    const authorization = payload.principalId
      ? await this.db.projectMember.findFirst({
          where: { projectId: version.projectId, principalId: payload.principalId, principal: { status: "active" } },
          select: { projectId: true },
        })
      : await this.db.shareGrant.findFirst({
          where: {
            id: payload.shareId, revision: payload.shareRevision, projectId: version.projectId,
            artifactVersionId: payload.artifactVersionId, scope: "view", status: "active",
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            release: { status: "ready", project: { status: "active" }, artifactPins: {
              some: { artifactId: payload.artifactId, artifactVersionId: payload.artifactVersionId, artifactVersion: { checksum: payload.checksum } },
            } },
          },
          select: { id: true },
        });
    if (!authorization) throw new Error("PREVIEW_NOT_FOUND");
    if (version.schemaVersion === 1) {
      const parsed = prototypeDocumentSchema.safeParse(version.content);
      if (!parsed.success || digest(canonicalJson(parsed.data)) !== payload.checksum) throw new Error("PREVIEW_NOT_FOUND");
      const assets: ExportBinaryAsset[] = [];
      let assetBytes = 0;
      for (const manifest of parsed.data.assets) {
        if (manifest.kind === "icon") continue;
        assetBytes += manifest.byteSize;
        if (!Number.isSafeInteger(assetBytes) || assetBytes > this.config.maximumHtmlBytes) throw new Error("PREVIEW_NOT_FOUND");
        const asset = version.assets.find(item => item.assetId === manifest.id);
        if (!asset || asset.kind !== manifest.kind || asset.blobId !== manifest.blobId
          || asset.sha256 !== manifest.sha256 || asset.mediaType !== manifest.mediaType || asset.byteSize !== BigInt(manifest.byteSize)
          || asset.blob.status !== "ready" || asset.blob.deletedAt !== null || asset.blob.sha256 !== manifest.sha256
          || asset.blob.byteSize !== BigInt(manifest.byteSize) || asset.blob.mediaType !== manifest.mediaType) throw new Error("PREVIEW_NOT_FOUND");
        const bytes = await this.storage.readAsset({ storageKey: asset.blob.storageKey, sha256: manifest.sha256,
          mediaType: manifest.mediaType, byteSize: manifest.byteSize }, this.config.maximumHtmlBytes, signal);
        assets.push({ assetId: manifest.id, kind: manifest.kind, blobId: manifest.blobId,
          sha256: manifest.sha256, mediaType: manifest.mediaType, byteSize: manifest.byteSize, bytes });
      }
      signal?.throwIfAborted();
      const html = renderPrototypeDocumentHtml(parsed.data, { assets, revisionId: payload.artifactVersionId }).document;
      if (Buffer.byteLength(html) > this.config.maximumHtmlBytes) throw new Error("PREVIEW_NOT_FOUND");
      return { capabilityToken: token, sourceHtml: html, etag: previewRepresentationEtag(digest(html), this.config.webOrigin, token) };
    }
    const parsed = sourcePrototypeDocumentSchema.safeParse(version.content);
    if (!parsed.success || digest(canonicalJson(parsed.data)) !== payload.checksum) throw new Error("PREVIEW_NOT_FOUND");
    const html = parsed.data.build.html;
    if (Buffer.byteLength(html) > this.config.maximumHtmlBytes || digest(html) !== parsed.data.build.htmlSha256) {
      throw new Error("PREVIEW_NOT_FOUND");
    }
    return { capabilityToken: token, sourceHtml: html, etag: previewRepresentationEtag(parsed.data.build.htmlSha256, this.config.webOrigin, token) };
  }

  async render(
    resolved: Awaited<ReturnType<PreviewService["resolve"]>>,
    signal?: AbortSignal,
  ) {
    if ("sourceHtml" in resolved) {
      signal?.throwIfAborted();
      const inspector = new WorkbenchPreviewHtmlInspector();
      await inspector.write(resolved.sourceHtml);
      const { headEndOffset } = await inspector.finish();
      const bridge = createWorkbenchPreviewBridgeInjection(this.config.webOrigin, resolved.capabilityToken);
      const html = resolved.sourceHtml.slice(0, headEndOffset) + bridge.markup + resolved.sourceHtml.slice(headEndOffset);
      const bytes = Buffer.from(html, "utf8");
      return {
        body: Readable.from([bytes]), byteSize: bytes.byteLength, etag: resolved.etag,
        contentSecurityPolicy: previewContentSecurityPolicy(html, this.config.webOrigin),
        dispose: async () => undefined,
      };
    }
    const staged = await this.storage.stageHtml(
      resolved.identity,
      this.config.maximumHtmlBytes,
      signal,
    );
    try {
      const bridge = createWorkbenchPreviewBridgeInjection(
        this.config.webOrigin,
        resolved.capabilityToken,
      );
      const streamed = staged.injectedStream(bridge.markup, signal);
      return {
        body: streamed.body,
        byteSize: streamed.byteSize,
        etag: resolved.etag,
        contentSecurityPolicy: previewContentSecurityPolicyFromHashes({
          scriptSha256: [...staged.inspection.scriptSha256, bridge.scriptSha256],
          styleSha256: staged.inspection.styleSha256,
        }, this.config.webOrigin),
        dispose: () => staged.dispose(),
      };
    } catch (error) {
      await staged.dispose();
      throw error;
    }
  }
}

function previewRepresentationEtag(blobSha256: string, webOrigin: string, capabilityToken: string) {
  const digest = createHash("sha256")
    .update("workbench.preview.representation.v1\0", "utf8")
    .update(blobSha256, "utf8")
    .update("\0", "utf8")
    .update(webOrigin, "utf8")
    .update("\0", "utf8")
    .update(capabilityToken, "utf8")
    .digest("hex");
  return `"${digest}"`;
}

function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }

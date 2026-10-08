import { createHash } from "node:crypto";
import type { PrismaClient } from "@workbench/workbench-db";
import { verifyPreviewToken } from "@workbench/workbench-preview-token";
import type { PreviewConfig } from "./config.js";
import { previewContentSecurityPolicyFromHashes } from "./csp.js";
import { createWorkbenchPreviewBridgeInjection } from "./preview-bridge.js";
import type { PreviewStorage } from "./storage.js";

export class PreviewService {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: PreviewStorage,
    private readonly config: Pick<PreviewConfig, "tokenSecret" | "tokenMaximumTtlSeconds" | "maximumHtmlBytes" | "webOrigin">,
  ) {}

  async resolve(token: string) {
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
        createdById: true,
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
            // Legacy capabilities keep their original short-lived semantics.
            // Newly issued capabilities follow the authorized requester.
            principalId: payload.principalId ?? job.createdById,
            ...(payload.principalId && job.purpose === "export"
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

  async render(
    resolved: Awaited<ReturnType<PreviewService["resolve"]>>,
    signal?: AbortSignal,
  ) {
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

  async get(token: string, signal?: AbortSignal) {
    return this.render(await this.resolve(token), signal);
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

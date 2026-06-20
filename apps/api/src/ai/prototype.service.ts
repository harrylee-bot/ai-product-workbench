import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  KnowledgeCandidateSource,
  ProjectStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeCandidateService } from "../knowledge/knowledge-candidate.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  ProductDesignState,
  PrototypeArtifact,
  PrototypeArtifactDraft,
  PrototypeSpec,
  PrototypeVersion,
} from "./ai-vibe.types";
import { PrototypeCodeAgentService } from "./agents/prototype-code-agent.service";
import { PrototypeDesignerAgentService } from "./agents/prototype-designer-agent.service";
import { KnowledgeExtractorAgentService } from "./agents/knowledge-extractor-agent.service";
import { ProductDesignStateService } from "./product-design-state.service";

type PrototypeSpecRecord = {
  id: string;
  projectId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  targetDevice: PrototypeTargetDevice;
  styleGuide: unknown;
  pages: unknown;
  navigation: unknown;
  interactions: unknown;
  assumptions: unknown;
  knowledgeRefs: unknown;
  generatedByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PrototypeArtifactRecord = {
  id: string;
  projectId: string;
  prototypeSpecId: string;
  productDesignStateId: string;
  productDesignStateVersion: number;
  title: string;
  status: PrototypeArtifactStatus;
  htmlContent: string | null;
  entryFilePath: string | null;
  previewUrl: string | null;
  targetDevice: PrototypeTargetDevice;
  pageCount: number;
  generatedByRunId: string | null;
  errorMessage: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PrototypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    private readonly prototypeDesignerAgent: PrototypeDesignerAgentService,
    private readonly prototypeCodeAgent: PrototypeCodeAgentService,
    private readonly knowledgeExtractorAgent?: KnowledgeExtractorAgentService,
    private readonly knowledgeCandidateService?: KnowledgeCandidateService,
  ) {}

  async generateForUser(
    user: AuthenticatedUser,
    projectId: string,
    input: { productDesignStateId?: string; targetDevice?: PrototypeTargetDevice },
  ) {
    const project = await this.assertProjectAccess(user, projectId);
    this.assertOwnerMutation(user, project.ownerId);
    const state = input.productDesignStateId
      ? await this.stateService.getStateByIdForProject(input.productDesignStateId, projectId)
      : await this.stateService.getCurrentState(projectId);
    if (!state) throw new NotFoundException("PROTOTYPE_STATE_NOT_FOUND");

    const runId = `manual-prototype-${Date.now()}`;
    const spec = await this.prototypeDesignerAgent.run({
      runId,
      projectId,
      traceId: runId,
      userId: user.id,
      input: {
        productDesignState: state,
        targetDevice: input.targetDevice ?? "both",
        generatedByRunId: runId,
      },
    });
    const draft = await this.prototypeCodeAgent.run({
      runId,
      projectId,
      traceId: runId,
      userId: user.id,
      input: {
        prototypeSpec: spec.data,
        mode: "single_html",
        generatedByRunId: runId,
      },
    });

    return this.saveGeneratedPrototype(state, spec.data, draft.data, {
      userId: user.id,
      runId,
      reason: "手动生成 HTML 原型",
    });
  }

  async saveGeneratedPrototype(
    state: ProductDesignState,
    prototypeSpec: PrototypeSpec,
    draft: PrototypeArtifactDraft,
    options: { userId: string; runId?: string; reason?: string },
  ) {
    const htmlContent = draft.htmlContent ?? draft.html ?? "";
    const safety = validateHtmlSafety(htmlContent);

    const specRecord = await this.prisma.prototypeSpecRecord.create({
      data: {
        id: prototypeSpec.id,
        projectId: state.projectId,
        productDesignStateId: state.id,
        productDesignStateVersion: state.version,
        title: prototypeSpec.title,
        targetDevice: toPrismaTargetDevice(prototypeSpec.targetDevice),
        styleGuide: toInputJson(prototypeSpec.styleGuide),
        pages: toInputJson(prototypeSpec.pages),
        navigation: toInputJson(prototypeSpec.navigation),
        interactions: toInputJson(prototypeSpec.interactions),
        assumptions: toInputJson(prototypeSpec.assumptions),
        knowledgeRefs: toInputJson(prototypeSpec.knowledgeRefs),
        generatedByRunId: options.runId ?? prototypeSpec.generatedByRunId,
      },
    });

    const artifactRecord = await this.prisma.prototypeArtifact.create({
      data: {
        projectId: state.projectId,
        prototypeSpecId: specRecord.id,
        productDesignStateId: state.id,
        productDesignStateVersion: state.version,
        title: draft.title ?? prototypeSpec.title,
        status: safety.ok ? PrototypeArtifactStatus.ready : PrototypeArtifactStatus.failed,
        htmlContent: safety.ok ? htmlContent : null,
        entryFilePath: draft.entryFilePath ?? draft.entryFile ?? "index.html",
        previewUrl: draft.previewUrl,
        targetDevice: toPrismaTargetDevice(draft.targetDevice ?? prototypeSpec.targetDevice),
        pageCount: draft.pageCount ?? (prototypeSpec.pages.length || 1),
        generatedByRunId: options.runId ?? draft.generatedByRunId,
        errorMessage: safety.ok ? draft.errorMessage : safety.reason,
        createdBy: options.userId,
        updatedBy: options.userId,
      },
    });

    const spec = this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord);
    const artifact = this.toArtifactItem(artifactRecord as PrototypeArtifactRecord);
    if (!safety.ok) {
      await this.createVersion(spec, artifact, options.userId, "原型生成失败：HTML 安全检查未通过");
      throw new BadRequestException("PROTOTYPE_HTML_UNSAFE");
    }

    await this.prisma.project.update({
      where: { id: state.projectId },
      data: { currentPrototypeArtifactId: artifact.id },
    });
    const version = await this.createVersion(
      spec,
      artifact,
      options.userId,
      options.reason ?? "HTML 原型生成完成",
    );
    return { prototypeSpec: spec, artifact, version };
  }

  async getCurrentForUser(user: AuthenticatedUser, projectId: string) {
    const project = await this.assertProjectAccess(user, projectId, { allowArchived: true });
    const artifact = project.currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: project.currentPrototypeArtifactId, projectId },
        })
      : await this.prisma.prototypeArtifact.findFirst({
          where: { projectId },
          orderBy: { updatedAt: "desc" },
        });
    return {
      artifact: artifact ? this.toArtifactItem(artifact as PrototypeArtifactRecord) : null,
    };
  }

  async getArtifactForUser(user: AuthenticatedUser, artifactId: string) {
    const artifact = await this.getAccessibleArtifact(user, artifactId);
    const prototypeSpec = await this.prisma.prototypeSpecRecord.findUnique({
      where: { id: artifact.prototypeSpecId },
    });
    return {
      artifact: this.toArtifactItem(artifact as PrototypeArtifactRecord),
      prototypeSpec: prototypeSpec
        ? this.toPrototypeSpecItem(prototypeSpec as PrototypeSpecRecord)
        : undefined,
    };
  }

  async getPreviewHtmlForUser(user: AuthenticatedUser, artifactId: string) {
    const artifact = await this.getAccessibleArtifact(user, artifactId);
    if (artifact.status !== PrototypeArtifactStatus.ready || !artifact.htmlContent) {
      throw new BadRequestException("PROTOTYPE_PREVIEW_NOT_READY");
    }
    const safety = validateHtmlSafety(artifact.htmlContent);
    if (!safety.ok) throw new BadRequestException("PROTOTYPE_HTML_UNSAFE");
    return artifact.htmlContent;
  }

  async listVersionsForUser(user: AuthenticatedUser, artifactId: string) {
    await this.getAccessibleArtifact(user, artifactId);
    const items = await this.prisma.prototypeVersion.findMany({
      where: { artifactId },
      orderBy: { version: "desc" },
    });
    return {
      items: items.map((item) => this.toVersionItem(item)),
    };
  }

  async confirmForUser(user: AuthenticatedUser, artifactId: string, reason?: string) {
    const current = await this.getAccessibleArtifact(user, artifactId);
    this.assertOwnerMutation(user, current.project.ownerId);
    const specRecord = await this.prisma.prototypeSpecRecord.findUniqueOrThrow({
      where: { id: current.prototypeSpecId },
    });
    const updated = await this.prisma.prototypeArtifact.update({
      where: { id: artifactId },
      data: { updatedBy: user.id },
    });
    const spec = this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord);
    const artifact = this.toArtifactItem(updated as PrototypeArtifactRecord);
    const version = await this.createVersion(spec, artifact, user.id, reason ?? "用户确认原型");
    const knowledgeCandidates = await this.extractKnowledgeCandidatesAfterConfirm(user.id, spec, artifact);
    return { artifact, version, knowledgeCandidates };
  }

  private async extractKnowledgeCandidatesAfterConfirm(
    userId: string,
    spec: PrototypeSpec,
    artifact: PrototypeArtifact,
  ) {
    if (!this.knowledgeExtractorAgent || !this.knowledgeCandidateService) return { items: [] };
    const state = await this.stateService.getStateByIdForProject(
      artifact.productDesignStateId,
      artifact.projectId,
    );
    if (!state) return { items: [] };
    const runId = `knowledge-prototype-${Date.now()}`;
    const output = await this.knowledgeExtractorAgent.run({
      runId,
      projectId: artifact.projectId,
      traceId: runId,
      userId,
      input: {
        projectId: artifact.projectId,
        productDesignState: state,
        prototypeSpec: spec,
        confirmedByUser: true,
        source: KnowledgeCandidateSource.prototype,
        sourceRefId: artifact.id,
        runId,
      },
    });
    return this.knowledgeCandidateService.createMany(artifact.projectId, output.data.candidates, {
      source: KnowledgeCandidateSource.prototype,
      sourceRefId: artifact.id,
      runId,
    });
  }

  private async createVersion(
    prototypeSpec: PrototypeSpec,
    artifact: PrototypeArtifact,
    createdBy: string,
    reason: string,
  ): Promise<PrototypeVersion> {
    const latest = await this.prisma.prototypeVersion.findFirst({
      where: { artifactId: artifact.id },
      orderBy: { version: "desc" },
    });
    const version = await this.prisma.prototypeVersion.create({
      data: {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        version: (latest?.version ?? 0) + 1,
        prototypeSpecSnapshot: toInputJson(prototypeSpec),
        artifactSnapshot: toInputJson(artifact),
        reason,
        createdBy,
      },
    });
    return this.toVersionItem(version);
  }

  private async assertProjectAccess(
    user: AuthenticatedUser,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    if (!options.allowArchived && project.status === ProjectStatus.archived) {
      throw new ForbiddenException("项目已归档，请先恢复后再继续操作");
    }
    if (user.role !== UserRole.admin && project.ownerId !== user.id) {
      throw new ForbiddenException("PROTOTYPE_ARTIFACT_FORBIDDEN");
    }
    return project;
  }

  private async getAccessibleArtifact(user: AuthenticatedUser, artifactId: string) {
    const artifact = await this.prisma.prototypeArtifact.findUnique({
      where: { id: artifactId },
      include: { project: true },
    });
    if (!artifact || artifact.project.deletedAt || artifact.project.status === ProjectStatus.deleted) {
      throw new NotFoundException("PROTOTYPE_ARTIFACT_NOT_FOUND");
    }
    if (user.role !== UserRole.admin && artifact.project.ownerId !== user.id) {
      throw new ForbiddenException("PROTOTYPE_ARTIFACT_FORBIDDEN");
    }
    return artifact;
  }

  private assertOwnerMutation(user: AuthenticatedUser, ownerId: string) {
    if (user.role === UserRole.admin && user.id !== ownerId) {
      throw new ForbiddenException("管理员不可直接修改用户项目原型");
    }
  }

  private toPrototypeSpecItem(record: PrototypeSpecRecord): PrototypeSpec {
    return {
      id: record.id,
      projectId: record.projectId,
      productDesignStateId: record.productDesignStateId,
      productDesignStateVersion: record.productDesignStateVersion,
      title: record.title,
      targetDevice: record.targetDevice,
      styleGuide: asRecord(record.styleGuide) as PrototypeSpec["styleGuide"],
      pages: Array.isArray(record.pages) ? record.pages as PrototypeSpec["pages"] : [],
      navigation: Array.isArray(record.navigation) ? record.navigation as PrototypeSpec["navigation"] : [],
      interactions: Array.isArray(record.interactions) ? record.interactions as PrototypeSpec["interactions"] : [],
      assumptions: Array.isArray(record.assumptions) ? record.assumptions as PrototypeSpec["assumptions"] : [],
      knowledgeRefs: Array.isArray(record.knowledgeRefs) ? record.knowledgeRefs as Array<Record<string, unknown>> : [],
      generatedByRunId: record.generatedByRunId ?? undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private toArtifactItem(record: PrototypeArtifactRecord): PrototypeArtifact {
    return {
      id: record.id,
      projectId: record.projectId,
      prototypeSpecId: record.prototypeSpecId,
      productDesignStateId: record.productDesignStateId,
      productDesignStateVersion: record.productDesignStateVersion,
      title: record.title,
      status: record.status,
      htmlContent: record.htmlContent ?? undefined,
      entryFilePath: record.entryFilePath ?? undefined,
      previewUrl: record.previewUrl ?? undefined,
      targetDevice: record.targetDevice,
      pageCount: record.pageCount,
      generatedByRunId: record.generatedByRunId ?? undefined,
      errorMessage: record.errorMessage ?? undefined,
      createdBy: record.createdBy,
      updatedBy: record.updatedBy ?? undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      html: record.htmlContent ?? undefined,
      entryFile: record.entryFilePath ?? undefined,
      assets: [],
    };
  }

  private toVersionItem(version: {
    id: string;
    projectId: string;
    artifactId: string;
    version: number;
    prototypeSpecSnapshot: unknown;
    artifactSnapshot: unknown;
    reason: string | null;
    createdBy: string;
    createdAt: Date;
  }): PrototypeVersion {
    return {
      id: version.id,
      projectId: version.projectId,
      artifactId: version.artifactId,
      version: version.version,
      prototypeSpecSnapshot: version.prototypeSpecSnapshot as PrototypeSpec,
      artifactSnapshot: version.artifactSnapshot as PrototypeArtifact,
      reason: version.reason ?? undefined,
      createdBy: version.createdBy,
      createdAt: version.createdAt.toISOString(),
    };
  }
}

export function validateHtmlSafety(html: string): { ok: true } | { ok: false; reason: string } {
  const checks: Array<[RegExp, string]> = [
    [/<script\b[^>]*\bsrc\s*=/i, "PROTOTYPE_HTML_REMOTE_SCRIPT"],
    [/\beval\s*\(/i, "PROTOTYPE_HTML_EVAL"],
    [/document\.cookie/i, "PROTOTYPE_HTML_COOKIE_ACCESS"],
    [/localStorage\.(setItem|removeItem|clear)/i, "PROTOTYPE_HTML_LOCAL_STORAGE_WRITE"],
    [/localStorage[^"']*(token|password|secret|credential|auth)/i, "PROTOTYPE_HTML_SENSITIVE_STORAGE"],
    [/window\.parent/i, "PROTOTYPE_HTML_PARENT_ACCESS"],
    [/<iframe\b/i, "PROTOTYPE_HTML_IFRAME"],
    [/\b(fetch\s*\(|XMLHttpRequest|axios\.)/i, "PROTOTYPE_HTML_NETWORK_CALL"],
    [/https?:\/\//i, "PROTOTYPE_HTML_REMOTE_URL"],
  ];
  const failed = checks.find(([pattern]) => pattern.test(html));
  return failed ? { ok: false, reason: failed[1] } : { ok: true };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toPrismaTargetDevice(value: string): PrototypeTargetDevice {
  if (value === PrototypeTargetDevice.desktop) return PrototypeTargetDevice.desktop;
  if (value === PrototypeTargetDevice.mobile) return PrototypeTargetDevice.mobile;
  return PrototypeTargetDevice.both;
}

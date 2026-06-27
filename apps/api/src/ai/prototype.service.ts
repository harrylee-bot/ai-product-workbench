import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  ProductDesignStateStatus,
  ProjectStatus,
  PrototypeArtifactStatus,
  PrototypeTargetDevice,
  RequirementDocumentStatus,
  UserRole,
} from "@prisma/client";
import type { AuthenticatedUser } from "../auth/auth.types";
import { KnowledgeCandidateService } from "../knowledge/knowledge-candidate.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInputJson } from "./ai-vibe.helpers";
import type {
  PrototypeComponentSpec,
  ProductDesignState,
  PrototypeArtifact,
  PrototypeArtifactDraft,
  PrototypePageSpec,
  PrototypeSpec,
  PrototypeVersion,
} from "./ai-vibe.types";
import { ProductDesignStateService } from "./product-design-state.service";
import { QaService } from "./qa.service";

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

type PrototypeStateNode = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  layout: Record<string, unknown>;
  children: PrototypeStateNode[];
};

@Injectable()
export class PrototypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stateService: ProductDesignStateService,
    @Optional()
    private readonly knowledgeCandidateService?: KnowledgeCandidateService,
    @Optional()
    private readonly qaService?: QaService,
  ) {}

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
    await this.assertProjectAccess(user, projectId, { allowArchived: true });
    return this.getCurrentForProject(projectId);
  }

  async getCurrentForProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.deletedAt || project.status === ProjectStatus.deleted) {
      throw new NotFoundException("项目不存在");
    }
    const state = await this.stateService.getCurrentState(projectId);
    const artifact = await this.getCurrentPrototypeArtifactForState(
      projectId,
      project.currentPrototypeArtifactId,
      state,
    );
    return {
      artifact: artifact ? this.toArtifactItem(artifact as PrototypeArtifactRecord) : null,
      productDesignState: state ?? null,
    };
  }

  async getPrototypeStateForUser(
    user: AuthenticatedUser,
    input: { projectId: string; artifactId?: string },
  ) {
    const project = await this.assertProjectAccess(user, input.projectId, { allowArchived: true });
    const state = input.artifactId ? undefined : await this.stateService.getCurrentState(input.projectId);
    const artifact = input.artifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: input.artifactId, projectId: input.projectId },
        })
      : await this.getCurrentPrototypeArtifactForState(
          input.projectId,
          project.currentPrototypeArtifactId,
          state,
        );

    if (!artifact) return { prototypeState: null };
    const specRecord = await this.prisma.prototypeSpecRecord.findUnique({
      where: { id: artifact.prototypeSpecId },
    });
    const artifactItem = this.toArtifactItem(artifact as PrototypeArtifactRecord);
    const spec = specRecord ? this.toPrototypeSpecItem(specRecord as PrototypeSpecRecord) : undefined;

    return {
      prototypeState: {
        id: artifactItem.id,
        projectId: artifactItem.projectId,
        artifactId: artifactItem.id,
        prototypeSpecId: artifactItem.prototypeSpecId,
        productDesignStateId: artifactItem.productDesignStateId,
        productDesignStateVersion: artifactItem.productDesignStateVersion,
        version: artifactItem.productDesignStateVersion,
        updatedAt: artifactItem.updatedAt,
        root: prototypeStateRoot(spec, artifactItem),
        pages: spec?.pages ?? [],
        interactions: spec?.interactions ?? [],
        sourceStateRef: {
          productDesignStateId: artifactItem.productDesignStateId,
          version: artifactItem.productDesignStateVersion,
        },
      },
      prototypeSpec: spec,
      artifact: artifactItem,
      productDesignState: state ?? null,
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
    if (current.status !== PrototypeArtifactStatus.ready || !current.htmlContent) {
      throw new BadRequestException("PROTOTYPE_CONFIRM_NOT_READY");
    }
    const qaGate = this.qaService
      ? await this.qaService.assertGateAllows(user, current.projectId, "confirm_artifacts")
      : undefined;
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
    const productDesignState = await this.stateService.attachGeneratedArtifacts(artifact.productDesignStateId, {
      prototypeSpec: spec,
      status: ProductDesignStateStatus.confirmed,
      userId: user.id,
      reason: `${reason ?? "用户确认原型"}，同步原型确认状态到 ProductDesignState`,
    });
    const knowledgeCandidates = qaGate && !qaGate.allowPersistKnowledge
      ? { items: [], qaGate }
      : await this.extractKnowledgeCandidatesAfterConfirm(user.id, spec, artifact);
    return { artifact, version, productDesignState, knowledgeCandidates, qaGate };
  }

  private async extractKnowledgeCandidatesAfterConfirm(
    userId: string,
    spec: PrototypeSpec,
    artifact: PrototypeArtifact,
  ) {
    void userId;
    void spec;
    void artifact;
    return { items: [] };
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

  private async getCurrentPrototypeArtifactForState(
    projectId: string,
    currentPrototypeArtifactId: string | null | undefined,
    state?: ProductDesignState,
  ) {
    const artifact = currentPrototypeArtifactId
      ? await this.prisma.prototypeArtifact.findFirst({
          where: { id: currentPrototypeArtifactId, projectId },
        })
      : await this.prisma.prototypeArtifact.findFirst({
          where: { projectId },
          orderBy: { updatedAt: "desc" },
        });

    if (!artifact || !state) return artifact;
    if (isArtifactFromCurrentState(artifact as PrototypeArtifactRecord, state)) return artifact;
    return null;
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

function isArtifactFromCurrentState(artifact: PrototypeArtifactRecord, state: ProductDesignState) {
  if (artifact.productDesignStateId !== state.id) return false;
  if (state.prototypeSpec?.id) return artifact.prototypeSpecId === state.prototypeSpec.id;
  return artifact.productDesignStateVersion === state.version;
}

function prototypeStateRoot(
  spec: PrototypeSpec | undefined,
  artifact: PrototypeArtifact,
): PrototypeStateNode {
  return {
    id: artifact.id,
    type: "prototype",
    props: {
      title: artifact.title,
      artifactId: artifact.id,
      prototypeSpecId: artifact.prototypeSpecId,
      status: artifact.status,
      sourceStateRef: artifact.productDesignStateId,
    },
    layout: {
      targetDevice: artifact.targetDevice,
      pageCount: artifact.pageCount,
    },
    children: spec?.pages.map(prototypePageNode) ?? [],
  };
}

function prototypePageNode(page: PrototypePageSpec): PrototypeStateNode {
  return {
    id: page.id,
    type: "page",
    props: {
      name: page.name,
      route: page.route,
      description: page.description,
      sourceStateRef: page.sourcePageId,
      sourcePaths: page.sourcePaths,
    },
    layout: {
      device: page.device,
      layout: page.layout,
      order: page.order,
    },
    children: page.components.map(prototypeComponentNode),
  };
}

function prototypeComponentNode(component: PrototypeComponentSpec): PrototypeStateNode {
  return {
    id: component.id,
    type: component.type,
    props: {
      name: component.name,
      description: component.description,
      content: component.content,
      sourcePaths: component.sourcePaths,
      states: component.states,
      interactions: component.interactions,
      ...(component.props ?? {}),
    },
    layout: {},
    children: (component.children ?? []).map(prototypeComponentNode),
  };
}

export function validateHtmlSafety(html: string): { ok: true } | { ok: false; reason: string } {
  const checks: Array<[RegExp, string]> = [
    [/<script\b[^>]*\bsrc\s*=/i, "PROTOTYPE_HTML_REMOTE_SCRIPT"],
    [/\beval\s*\(/i, "PROTOTYPE_HTML_EVAL"],
    [/document\.cookie/i, "PROTOTYPE_HTML_COOKIE_ACCESS"],
    [/localStorage\.(setItem|removeItem|clear)/i, "PROTOTYPE_HTML_LOCAL_STORAGE_WRITE"],
    [/localStorage[^"']*(token|password|secret|credential|auth)/i, "PROTOTYPE_HTML_SENSITIVE_STORAGE"],
    [/(?:window\s*\.\s*)?(?:parent|top)\s*[\.\[]|\bframeElement\b/i, "PROTOTYPE_HTML_PARENT_ACCESS"],
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

import { ConfigService } from "@nestjs/config";
import { boardNodeProtocol } from "@workbench/workbench-contracts";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { verifyPreviewToken } from "@workbench/workbench-preview-token";
import { ExportPreviewConfig } from "../src/modules/exports/export-preview.config.js";
import { ExportCapabilitiesConfig } from "../src/modules/exports/export-capabilities.config.js";
import { ExportsController } from "../src/modules/exports/exports.controller.js";
import { ExportsService } from "../src/modules/exports/exports.service.js";
import { hashRequest } from "../src/common/idempotency.js";
import { canonicalSha256 } from "../src/modules/releases/release.mapper.js";

const now = new Date("2026-07-13T00:00:00.000Z");

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "export_1",
    releaseId: "release_1",
    createdById: "principal_1",
    idempotencyKey: "export:key:123",
    requestHash: "a".repeat(64),
    format: "html" as const,
    packaging: "single_file" as const,
    selectionKind: "artifact" as const,
    selectionArtifactId: "artifact_1",
    selectionArtifactVersionId: "version_1",
    selectionScreenId: null,
    selectionNodeIds: [],
    status: "queued" as const,
    revision: 0,
    options: {},
    outputBlobId: null,
    outputBlob: null,
    failureCode: null,
    failureDetail: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function readyRelease() {
  const boardSnapshot = {
    id: "board_1",
    projectId: "project_1",
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  };
  const boardChecksum = canonicalSha256(boardSnapshot);
  const manifest = {
    protocol: "workbench.project-release.v1",
    projectId: "project_1",
    releaseVersion: 1,
    board: { id: "board_1", revision: 1, checksum: boardChecksum },
    artifacts: [],
  };
  return {
    id: "release_1",
    projectId: "project_1",
    version: 1,
    status: "ready",
    createdById: "principal_1",
    boardId: "board_1",
    boardRevision: 1,
    boardSnapshot,
    boardChecksum,
    manifest,
    manifestSha256: canonicalSha256(manifest),
    failureCode: null,
    failureDetail: null,
    createdAt: now,
    finishedAt: now,
    updatedAt: now,
    artifactPins: [],
  };
}

function prototypeDocument() {
  const literal = (value: number) => ({ kind: "literal" as const, value });
  const frame = (id: string, screenId: string) => ({
    id,
    screenId,
    parentId: null,
    name: id,
    kind: "frame" as const,
    visible: true,
    layout: {
      mode: "absolute" as const,
      x: literal(0),
      y: literal(0),
      width: literal(390),
      height: literal(844),
      display: "block" as const,
      direction: "column" as const,
      gap: literal(0),
      padding: { top: literal(0), right: literal(0), bottom: literal(0), left: literal(0) },
      align: "stretch" as const,
      justify: "start" as const,
      gridColumns: null,
      overflow: "hidden" as const,
    },
    style: {
      opacity: 1,
      rotation: 0,
      transformOrigin: { x: 0.5, y: 0.5 },
      fill: null,
      stroke: null,
      radii: {
        topLeft: literal(0),
        topRight: literal(0),
        bottomRight: literal(0),
        bottomLeft: literal(0),
      },
      shadowTokenIds: [],
      typography: null,
    },
    actionIds: [],
    bindingIds: [],
    motionIds: [],
    childIds: [],
    clipContent: true,
  });
  return {
    protocol: "workbench.prototype.v1" as const,
    documentId: "document-1",
    title: "Checkout",
    revision: 1,
    screens: [
      { id: "screen-home", name: "Home", route: "/", rootNodeId: "root-home", initialStateId: null, viewport: { width: 390, height: 844 } },
      { id: "screen-success", name: "Success", route: "/success", rootNodeId: "root-success", initialStateId: null, viewport: { width: 390, height: 844 } },
    ],
    nodes: [frame("root-home", "screen-home"), frame("root-success", "screen-success")],
    tokens: [],
    assets: [],
    variables: [],
    states: [],
    actions: [],
    bindings: [],
    motions: [],
  };
}

function readyReleaseWithKinds(kinds: Array<"prototype" | "design_system" | "data" | "prd">) {
  const release: any = readyRelease();
  release.artifactPins = kinds.map((kind, position) => {
    const artifactId = `artifact_${position + 1}`;
    const artifactVersionId = `version_${position + 1}`;
    return {
      position,
      artifactId,
      artifactVersionId,
      title: `${kind}-${position + 1}`,
      kind,
      artifactVersion: {
        id: artifactVersionId,
        artifactId,
        projectId: release.projectId,
        version: 1,
        schemaVersion: 1,
        status: "ready",
        checksum: String.fromCharCode(97 + position).repeat(64),
        artifact: { id: artifactId, projectId: release.projectId },
        assets: [],
      },
    };
  });
  const manifestPins = release.artifactPins.map((pin: any) => ({
    position: pin.position,
    artifactId: pin.artifactId,
    artifactVersionId: pin.artifactVersionId,
    title: pin.title,
    kind: pin.kind,
    version: pin.artifactVersion.version,
    schemaVersion: pin.artifactVersion.schemaVersion,
    checksum: pin.artifactVersion.checksum,
    assets: [],
  }));
  release.boardSnapshot.nodes = manifestPins.map((pin: any) => ({
    id: `node_${pin.position + 1}`,
    kind: "artifact",
    parentNodeId: null,
    order: pin.position,
    position: { x: pin.position * 440, y: 0 },
    size: { width: 400, height: 300 },
    artifactId: pin.artifactId,
    artifactVersionId: pin.artifactVersionId,
    data: {
      protocol: boardNodeProtocol,
      nodeType: "artifact",
      title: pin.title,
      artifactKind: pin.kind,
    },
  }));
  release.boardChecksum = canonicalSha256(release.boardSnapshot);
  release.manifest = {
    ...release.manifest,
    board: { ...release.manifest.board, checksum: release.boardChecksum },
    artifacts: manifestPins,
  };
  release.manifestSha256 = canonicalSha256(release.manifest);
  return release;
}

function serviceWith(
  db: object,
  queue: object = {},
  storage: object = {},
  preview: object = {},
  capabilities: object = {
    catalog: () => ({
      formats: {
        html: { available: true, authentication: "not_required", reasonCode: null },
        react: { available: true, authentication: "not_required", reasonCode: null },
        figma: { available: true, authentication: "not_required", reasonCode: null },
        mcp: { available: true, authentication: "not_required", reasonCode: null },
        docx: { available: true, authentication: "not_required", reasonCode: null },
        pdf: { available: true, authentication: "not_required", reasonCode: null },
      },
      packaging: {
        single_file: { available: true, authentication: "not_required", reasonCode: null },
        zip: { available: true, authentication: "not_required", reasonCode: null },
      },
      external: {
        ai_studio: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
        },
        netlify: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        lovable: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        bolt: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
      },
    }),
    materializeOptions: (_format: string, options: object) => ({ ...options }),
  },
) {
  return new ExportsService(
    db as never,
    { findProject: vi.fn().mockResolvedValue({ id: "project_1" }) } as never,
    queue as never,
    storage as never,
    preview as never,
    capabilities as never,
  );
}

describe("ExportJob API invariants", () => {
  it("keeps HTTP status metadata aligned with the 202 command and 200 state transitions", () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ExportsController.prototype.create)).toBe(202);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ExportsController.prototype.cancel)).toBe(200);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ExportsController.prototype.createPreviewToken)).toBe(200);
  });

  it("reports the fixed official-importer Figma capability without a deployment secret", () => {
    const capabilities = new ExportCapabilitiesConfig();
    expect(capabilities.catalog()).toEqual({
      formats: {
        html: { available: true, authentication: "not_required", reasonCode: null },
        react: { available: true, authentication: "not_required", reasonCode: null },
        figma: { available: true, authentication: "not_required", reasonCode: null },
        mcp: { available: true, authentication: "not_required", reasonCode: null },
        docx: { available: true, authentication: "not_required", reasonCode: null },
        pdf: { available: true, authentication: "not_required", reasonCode: null },
      },
      packaging: {
        single_file: { available: true, authentication: "not_required", reasonCode: null },
        zip: { available: true, authentication: "not_required", reasonCode: null },
      },
      external: {
        ai_studio: {
          available: false,
          authentication: "not_required",
          reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE",
        },
        netlify: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        lovable: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
        bolt: {
          available: false,
          authentication: "required",
          reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
        },
      },
    });
  });

  it("keeps the E2E external-delivery capability closed outside the test runtime", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalE2eTarget = process.env.WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE;
    try {
      process.env.NODE_ENV = "production";
      process.env.WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE = "netlify";

      expect(new ExportCapabilitiesConfig().catalog().external.netlify).toEqual({
        available: false,
        authentication: "required",
        reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
      });
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalE2eTarget === undefined) delete process.env.WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE;
      else process.env.WORKBENCH_E2E_EXTERNAL_DELIVERY_AVAILABLE = originalE2eTarget;
    }
  });

  it("rejects client-controlled Figma options before persistence", async () => {
    const db = {
      projectRelease: { findFirst: vi.fn() },
      exportJob: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };
    const queue = { sendInTransaction: vi.fn() };
    const service = serviceWith(db, queue);

    const failure = await service.create("principal_1", "project_1", "export:key:123", {
      releaseId: "release_1",
      format: "figma",
      packaging: "zip",
      selection: { kind: "release" },
      options: { converter: "client-controlled" },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 400 });
    expect(JSON.stringify(failure)).not.toContain("client-controlled");
    expect(db.projectRelease.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it.each(["docx", "pdf"] as const)("queues %s as one downloadable document", async (format) => {
    let created: ReturnType<typeof queuedJob> | undefined;
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = queuedJob(data);
          return created;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => created),
      },
      projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyReleaseWithKinds(["prd"])) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const result = await serviceWith(db, queue).create("principal_1", "project_1", `export:key:${format}`, {
      releaseId: "release_1",
      format,
      packaging: "single_file",
      selection: { kind: "release" },
      options: {},
    });

    expect(result).toMatchObject({ format, packaging: "single_file", status: "queued" });
    expect(tx.exportJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ format, packaging: "single_file" }),
    }));
    expect(queue.sendInTransaction).toHaveBeenCalledOnce();
  });

  it.each([
    ["docx", "zip"],
    ["pdf", "zip"],
    ["react", "single_file"],
    ["figma", "single_file"],
    ["mcp", "single_file"],
  ] as const)("rejects %s with %s before persistence", async (format, packaging) => {
    const db = {
      projectRelease: { findFirst: vi.fn() },
      exportJob: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };
    const queue = { sendInTransaction: vi.fn() };
    await expect(serviceWith(db, queue).create("principal_1", "project_1", `export:key:${format}`, {
      releaseId: "release_1",
      format,
      packaging,
      selection: { kind: "release" },
      options: {},
    })).rejects.toMatchObject({ status: 400 });
    expect(db.projectRelease.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(queue.sendInTransaction).not.toHaveBeenCalled();
  });

  it("persists an empty Figma option set and queues the formal importer package", async () => {
    const capabilities = new ExportCapabilitiesConfig();
    let created: ReturnType<typeof queuedJob> | undefined;
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = queuedJob(data);
          return created;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => created),
      },
      projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
      releaseArtifactVersion: { findUnique: vi.fn() },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyReleaseWithKinds(["prototype"])) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = serviceWith(db, queue, {}, {}, capabilities);

    const result = await service.create("principal_1", "project_1", "export:key:figma", {
      releaseId: "release_1",
      format: "figma",
      packaging: "zip",
      selection: { kind: "release" },
      options: {},
    });

    expect(created!.options).toEqual({});
    expect(result.options).toEqual({});
    expect(queue.sendInTransaction).toHaveBeenCalledOnce();
  });

  it("rejects Design System-only and mixed Figma selections before persistence", async () => {
    const capabilities = new ExportCapabilitiesConfig();

    for (const [release, expectedDetail] of [
      [readyReleaseWithKinds(["design_system"]), "Design System-only"],
      [readyReleaseWithKinds(["prototype", "design_system"]), "mixed selection"],
    ] as const) {
      const db = {
        projectRelease: { findFirst: vi.fn().mockResolvedValue(release) },
        exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn(),
      };
      const queue = { sendInTransaction: vi.fn() };
      const service = serviceWith(db, queue, {}, {}, capabilities);

      const idempotencyKey = expectedDetail === "Design System-only"
        ? "export:key:design-system"
        : "export:key:mixed";
      const failure = await service.create("principal_1", "project_1", idempotencyKey, {
        releaseId: "release_1",
        format: "figma",
        packaging: "zip",
        selection: { kind: "release" },
        options: {},
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ status: 400 });
      expect(JSON.stringify(failure)).toContain(expectedDetail);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(queue.sendInTransaction).not.toHaveBeenCalled();
    }
  });

  it("rejects an Artifact selection not pinned by the exact Release", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyRelease()) },
      releaseArtifactVersion: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyRelease()) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = serviceWith(db);

    await expect(service.create("principal_1", "project_1", "export:key:123", {
      releaseId: "release_1",
      format: "html",
      packaging: "single_file",
      selection: {
        kind: "artifact",
        artifactId: "artifact_1",
        artifactVersionId: "version_outside_release",
      },
      options: {},
    })).rejects.toMatchObject({ status: 400 });
    expect(tx.exportJob.create).not.toHaveBeenCalled();
  });

  it("rejects Board-node selections containing ids outside the immutable Release Board", async () => {
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyReleaseWithKinds(["prototype"])) },
      exportJob: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    };
    const service = serviceWith(db);

    await expect(service.create("principal_1", "project_1", "export:key:outside-node", {
      releaseId: "release_1",
      format: "html",
      packaging: "single_file",
      selection: { kind: "board_nodes", nodeIds: ["node_outside_release"] },
      options: {},
    })).rejects.toMatchObject({ status: 400 });
    expect(db.exportJob.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("persists and returns the exact canonical Board-node selection", async () => {
    let created: ReturnType<typeof queuedJob> | undefined;
    const release = readyReleaseWithKinds(["prototype", "data"]);
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = queuedJob(data);
          return created;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => created),
      },
      projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
      releaseArtifactVersion: { findUnique: vi.fn() },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(release) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = serviceWith(db, queue);

    const result = await service.create("principal_1", "project_1", "export:key:board-nodes", {
      releaseId: "release_1",
      format: "html",
      packaging: "single_file",
      selection: { kind: "board_nodes", nodeIds: ["node_1", "node_2"] },
      options: {},
    });

    expect(result.selection).toEqual({ kind: "board_nodes", nodeIds: ["node_1", "node_2"] });
    expect(created!.selectionNodeIds).toEqual(["node_1", "node_2"]);
    expect(created!.selectionArtifactId).toBeNull();
    expect(created!.selectionArtifactVersionId).toBeNull();
    expect(created!.selectionScreenId).toBeNull();
    expect(tx.releaseArtifactVersion.findUnique).not.toHaveBeenCalled();
  });

  it("evaluates Figma support against Artifact descendants of selected Frames", async () => {
    const capabilities = new ExportCapabilitiesConfig();
    let created: ReturnType<typeof queuedJob> | undefined;
    const release = readyReleaseWithKinds(["prototype", "design_system"]);
    release.boardSnapshot.nodes[0].parentNodeId = "frame_1";
    release.boardSnapshot.nodes[0].order = 0;
    release.boardSnapshot.nodes.push({
      id: "frame_1",
      kind: "frame",
      parentNodeId: null,
      order: 0,
      position: { x: 0, y: 0 },
      size: { width: 420, height: 320 },
      artifactId: null,
      artifactVersionId: null,
      data: {
        protocol: boardNodeProtocol,
        nodeType: "frame",
        title: "Prototype flow",
        fill: null,
        stroke: "#5f6368",
      },
    });
    release.boardChecksum = canonicalSha256(release.boardSnapshot);
    release.manifest.board.checksum = release.boardChecksum;
    release.manifestSha256 = canonicalSha256(release.manifest);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = queuedJob(data);
          return created;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => created),
      },
      projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
      releaseArtifactVersion: { findUnique: vi.fn() },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(release) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const service = serviceWith(db, queue, {}, {}, capabilities);

    await expect(service.create("principal_1", "project_1", "export:key:figma-selected-node", {
      releaseId: "release_1",
      format: "figma",
      packaging: "zip",
      selection: { kind: "board_nodes", nodeIds: ["frame_1"] },
      options: {},
    })).resolves.toMatchObject({ selection: { kind: "board_nodes", nodeIds: ["frame_1"] } });
    expect(created!.options).toEqual({});
  });

  it("rejects a missing screen and screenId on non-Prototype Artifacts", async () => {
    const cases = [
      {
        kind: "prototype" as const,
        screenId: "screen-missing",
        pin: {
          releaseId: "release_1",
          kind: "prototype",
          artifactVersion: {
            status: "ready",
            content: prototypeDocument(),
            contentBlobId: null,
            artifact: { kind: "prototype" },
          },
        },
      },
      {
        kind: "data" as const,
        screenId: "screen-home",
        pin: {
          releaseId: "release_1",
          kind: "data",
          artifactVersion: {
            status: "ready",
            content: { rows: [] },
            contentBlobId: null,
            artifact: { kind: "data" },
          },
        },
      },
    ];

    for (const testCase of cases) {
      const create = vi.fn();
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
        projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
        exportJob: { findUnique: vi.fn().mockResolvedValue(null), create },
        projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
        releaseArtifactVersion: { findUnique: vi.fn().mockResolvedValue(testCase.pin) },
      };
      const db = {
        projectRelease: { findFirst: vi.fn().mockResolvedValue(readyReleaseWithKinds([testCase.kind])) },
        exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
        $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
      };
      const service = serviceWith(db);

      await expect(service.create(
        "principal_1",
        "project_1",
        `export:key:${testCase.kind}`,
        {
          releaseId: "release_1",
          format: "html",
          packaging: "single_file",
          selection: {
            kind: "artifact",
            artifactId: "artifact_1",
            artifactVersionId: "version_1",
            screenId: testCase.screenId,
          },
          options: {},
        },
      )).rejects.toMatchObject({ status: 400 });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("persists the receipt and enqueues the validated export.build payload in one transaction", async () => {
    let created: ReturnType<typeof queuedJob> | undefined;
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("job_1") };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "editor" }) },
      exportJob: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = queuedJob(data);
          return created;
        }),
        findUniqueOrThrow: vi.fn().mockImplementation(() => created),
      },
      projectRelease: { findFirst: vi.fn().mockResolvedValue({ id: "release_1" }) },
      releaseArtifactVersion: {
        findUnique: vi.fn().mockResolvedValue({
          releaseId: "release_1",
          kind: "prototype",
          artifactVersion: {
            status: "ready",
            content: prototypeDocument(),
            contentBlobId: null,
            artifact: { kind: "prototype" },
          },
        }),
      },
    };
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(readyRelease()) },
      exportJob: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = serviceWith(db, queue);

    const result = await service.create("principal_1", "project_1", "export:key:123", {
      releaseId: "release_1",
      format: "html",
      packaging: "single_file",
      selection: {
        kind: "artifact",
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenId: "screen-success",
      },
      options: {},
    });

    expect(result).toMatchObject({
      id: "export_1",
      status: "queued",
      revision: 0,
      selection: { kind: "artifact", screenId: "screen-success" },
    });
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      "export.build",
      { exportJobId: "export_1" },
      { singletonKey: "export_1" },
    );
    expect(created!.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created!.selectionScreenId).toBe("screen-success");
  });

  it("validates endpoint Project ownership before replaying an idempotency receipt", async () => {
    const db = {
      projectRelease: { findFirst: vi.fn().mockResolvedValue(null) },
      exportJob: { findUnique: vi.fn() },
    };
    const service = serviceWith(db);
    await expect(service.create("principal_1", "project_1", "export:key:123", {
      releaseId: "release_other_project",
      format: "html",
      packaging: "single_file",
      selection: { kind: "release" },
      options: {},
    })).rejects.toMatchObject({ status: 404 });
    expect(db.exportJob.findUnique).not.toHaveBeenCalled();
  });

  it("returns 409 until authorized Export bytes are actually succeeded and readable", async () => {
    const db = {
      exportJob: { findFirst: vi.fn().mockResolvedValue(queuedJob()) },
    };
    const storage = { getObject: vi.fn() };
    const service = serviceWith(db, {}, storage);

    await expect(service.getContent("principal_1", "export_1")).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "EXPORT_STATE_CONFLICT" }),
    });
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("mints preview capability only for authorized succeeded HTML without selecting storage identity", async () => {
    const db = {
      exportJob: {
        findFirst: vi.fn().mockResolvedValue({
          id: "export_1",
          status: "succeeded",
          format: "html",
          packaging: "single_file",
          outputBlob: {
            id: "blob_1",
            status: "ready",
            deletedAt: null,
            mediaType: "text/html; charset=utf-8",
            byteSize: 128n,
            sha256: "b".repeat(64),
          },
        }),
      },
    };
    const preview = {
      createCapability: vi.fn().mockReturnValue({
        url: "https://preview.example.com/preview/signed-token",
        expiresAt: new Date("2026-07-13T01:00:00.000Z"),
      }),
    };
    const service = serviceWith(db, {}, {}, preview);

    await expect(service.createPreviewToken("principal_1", "export_1")).resolves.toEqual({
      url: "https://preview.example.com/preview/signed-token",
      expiresAt: "2026-07-13T01:00:00.000Z",
    });
    const query = JSON.stringify(db.exportJob.findFirst.mock.calls[0]![0]);
    expect(query).not.toContain("storageKey");
    expect(query).not.toContain("sha256");
    expect(query).not.toContain("createdById");
    expect(query).not.toContain("tokenHash");
  });

  it("lets a viewer queue a private Preview without creating a public Export", async () => {
    const previewExport = queuedJob({
      id: "preview-export-1",
      releaseId: null,
      idempotencyKey: "preview:preview:key:1",
    });
    const previewRecord = {
      id: "preview-1",
      projectId: "project_1",
      boardId: "board_1",
      boardRevision: 0,
      exportJobId: previewExport.id,
      createdById: "viewer_1",
      idempotencyKey: "preview:key:1",
      requestHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
      exportJob: previewExport,
    };
    const board = {
      id: "board_1",
      projectId: "project_1",
      revision: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      edges: [],
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
        .mockResolvedValueOnce([{ id: "board_1", revision: 0 }])
        .mockResolvedValueOnce([]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "viewer" }) },
      board: { findUniqueOrThrow: vi.fn().mockResolvedValue(board) },
      artifactVersion: { findMany: vi.fn().mockResolvedValue([]) },
      projectPreview: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(previewRecord),
        findUniqueOrThrow: vi.fn().mockResolvedValue(previewRecord),
      },
      exportJob: { create: vi.fn().mockResolvedValue(previewExport) },
    };
    const db = {
      projectPreview: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("queue-preview-1") };
    const service = serviceWith(db, queue);

    const result = await service.createPreview("viewer_1", "project_1", "preview:key:1", {
      boardId: "board_1",
      boardRevision: 0,
      selection: { kind: "release" },
    });

    expect(result.id).toBe("preview-1");
    expect(result.status).toBe("queued");
    expect(tx.exportJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        purpose: "preview",
        format: "html",
        packaging: "single_file",
        releaseId: null,
      }),
    }));
    expect(tx.projectPreview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        boardId: "board_1",
        boardRevision: 0,
        artifactPins: { create: [] },
      }),
    }));
    expect(queue.sendInTransaction).toHaveBeenCalledWith(
      tx,
      "export.build",
      { exportJobId: "preview-export-1" },
      { singletonKey: "preview-export-1" },
    );
  });

  it("replays a concurrent ProjectPreview receipt without remapping an API DTO as a database record", async () => {
    const request = {
      boardId: "board_1",
      boardRevision: 0,
      selection: { kind: "release" as const },
    };
    const previewExport = queuedJob({
      id: "preview-export-1",
      releaseId: null,
    });
    const previewRecord = {
      id: "preview-1",
      projectId: "project_1",
      boardId: "board_1",
      boardRevision: 0,
      exportJobId: previewExport.id,
      createdById: "viewer_1",
      idempotencyKey: "preview:key:1",
      requestHash: hashRequest(request),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
      exportJob: previewExport,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "project_1", revision: 0 }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "viewer" }) },
      projectPreview: { findUnique: vi.fn().mockResolvedValue(previewRecord) },
    };
    const db = {
      projectPreview: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const service = serviceWith(db);

    await expect(service.createPreview("viewer_1", "project_1", "preview:key:1", request))
      .resolves.toMatchObject({ id: "preview-1", status: "queued" });
  });

  it.each([
    { initialScreenId: "screen-success", kind: "prototype", valid: true },
    { initialScreenId: "screen-missing", kind: "prototype", valid: false },
    { initialScreenId: "screen-success", kind: "data", valid: false },
  ])("validates and persists the Preview opening screen without cropping ($kind/$initialScreenId)", async ({
    initialScreenId, kind, valid,
  }) => {
    const previewExport = queuedJob({ id: "preview-export-1", releaseId: null });
    const request = {
      boardId: "board_1",
      boardRevision: 0,
      selection: {
        kind: "artifact" as const,
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
      },
      initialScreenId,
    };
    const previewRecord = {
      id: "preview-1",
      projectId: "project_1",
      ...request,
      exportJobId: previewExport.id,
      createdById: "viewer_1",
      idempotencyKey: "preview:key:screen",
      requestHash: hashRequest(request),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
      exportJob: previewExport,
    };
    const tx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ id: "project_1", revision: 0 }])
        .mockResolvedValueOnce([{ id: "board_1", revision: 0 }])
        .mockResolvedValueOnce([{ id: "artifact_1", title: "Checkout", currentVersionId: "version_1" }]),
      projectMember: { findUnique: vi.fn().mockResolvedValue({ role: "viewer" }) },
      board: { findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "board_1",
        projectId: "project_1",
        revision: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
      }) },
      artifactVersion: {
        findMany: vi.fn().mockResolvedValue([{
          id: "version_1",
          artifactId: "artifact_1",
          projectId: "project_1",
          version: 1,
          schemaVersion: 1,
          status: "ready",
          checksum: "b".repeat(64),
          artifact: { projectId: "project_1", kind },
          assets: [],
        }]),
        findFirst: vi.fn().mockResolvedValue({
          status: "ready",
          content: prototypeDocument(),
          contentBlobId: null,
          artifact: { kind },
        }),
      },
      projectPreview: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(previewRecord),
        findUniqueOrThrow: vi.fn().mockResolvedValue(previewRecord),
      },
      exportJob: { create: vi.fn().mockResolvedValue(previewExport) },
    };
    const db = {
      projectPreview: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation((callback) => callback(tx)),
    };
    const queue = { sendInTransaction: vi.fn().mockResolvedValue("queued") };
    const service = serviceWith(db, queue);
    const result = service.createPreview("viewer_1", "project_1", "preview:key:screen", request);
    if (!valid) {
      await expect(result).rejects.toMatchObject({ status: 400 });
      expect(tx.projectPreview.create).not.toHaveBeenCalled();
      expect(queue.sendInTransaction).not.toHaveBeenCalled();
      return;
    }
    await expect(result).resolves.toMatchObject({ initialScreenId, selection: request.selection });
    expect(tx.exportJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ selectionScreenId: null }),
    }));
    expect(tx.projectPreview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ initialScreenId, requestHash: hashRequest(request) }),
    }));
  });

  it("rejects Preview screen crops before writing or replaying a receipt", async () => {
    const db = { projectPreview: { findUnique: vi.fn() }, $transaction: vi.fn() };
    await expect(serviceWith(db).createPreview("viewer_1", "project_1", "preview:key:crop", {
      boardId: "board_1",
      boardRevision: 0,
      selection: {
        kind: "artifact",
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        screenId: "screen-success",
      },
    })).rejects.toMatchObject({ status: 400 });
    expect(db.projectPreview.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("keeps private Preview jobs outside every public Export read and command surface", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { exportJob: { findMany, findFirst } };
    const storage = { getObject: vi.fn() };
    const service = serviceWith(db, {}, storage);

    await expect(service.list("principal_1", "project_1")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(service.get("principal_1", "preview-export-1"))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.getContent("principal_1", "preview-export-1"))
      .rejects.toMatchObject({ status: 404 });
    await expect(service.cancel("principal_1", "preview-export-1", 0))
      .rejects.toMatchObject({ status: 404 });

    const filters = [findMany.mock.calls[0]![0], ...findFirst.mock.calls.map(([query]) => query)]
      .map((query) => query.where);
    expect(filters).toHaveLength(4);
    for (const filter of filters) {
      expect(filter).toMatchObject({ purpose: "export", preview: null });
    }
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("mints a Preview token for a read-authorized viewer without exposing export content", async () => {
    const preview = {
      id: "preview-1",
      expiresAt: new Date(Date.now() + 60_000),
      exportJob: {
        id: "preview-export-1",
        status: "succeeded" as const,
        format: "html" as const,
        packaging: "single_file" as const,
        outputBlob: {
          id: "blob_preview_1",
          status: "ready" as const,
          deletedAt: null,
          mediaType: "text/html; charset=utf-8",
          byteSize: 128n,
          sha256: "c".repeat(64),
        },
      },
    };
    const db = { projectPreview: { findFirst: vi.fn().mockResolvedValue(preview) } };
    const previewConfig = {
      createCapability: vi.fn().mockReturnValue({
        url: "https://preview.example.com/preview/temporary",
        expiresAt: new Date("2026-07-13T01:00:00.000Z"),
      }),
    };
    const service = serviceWith(db, {}, {}, previewConfig);

    await expect(service.createProjectPreviewToken("viewer_1", "preview-1")).resolves.toEqual({
      url: "https://preview.example.com/preview/temporary",
      expiresAt: "2026-07-13T01:00:00.000Z",
    });
    expect(JSON.stringify(db.projectPreview.findFirst.mock.calls[0]![0])).not.toContain("storageKey");
    expect(previewConfig.createCapability).toHaveBeenCalledWith(
      "preview-export-1",
      expect.any(Date),
      preview.expiresAt,
    );
  });

  it("uses a server-fixed short TTL and a token payload containing only Export identity and expiry", () => {
    const secret = Buffer.alloc(32, 7);
    const values: Record<string, string> = {
      WORKBENCH_PREVIEW_ORIGIN: "https://preview.example.com",
      WORKBENCH_WEB_ORIGIN: "https://workbench.example.com",
      WORKBENCH_PREVIEW_TOKEN_SECRET: secret.toString("base64url"),
      WORKBENCH_PREVIEW_TOKEN_MAX_TTL_SECONDS: "60",
    };
    const config = new ExportPreviewConfig({
      getOrThrow: (name: string) => {
        const value = values[name];
        if (!value) throw new Error(`missing ${name}`);
        return value;
      },
      get: (name: string) => values[name],
    } as ConfigService);
    const capability = config.createCapability("export_1", now);
    const token = new URL(capability.url).pathname.split("/").at(-1)!;
    const payload = verifyPreviewToken(token, secret, { now, maximumTtlSeconds: 60 });

    expect(payload).toEqual({ exportJobId: "export_1", expiresAt: capability.expiresAt });
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"))
      .toBe('{"v":1,"exportJobId":"export_1","exp":1783900860}');
  });

  it("rejects a Preview origin that shares the Web origin", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    expect(() => new ExportPreviewConfig({
      getOrThrow: (name: string) => name === "WORKBENCH_PREVIEW_TOKEN_SECRET"
        ? secret
        : "https://workbench.example.com",
      get: () => undefined,
    } as unknown as ConfigService)).toThrow("must be independent");
  });
});

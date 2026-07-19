import { createHash } from "node:crypto";
import {
  canonicalJson,
  designPresetDefinitionFromCatalogItem,
  designPresetCatalogSchema,
  runtimePresetDesignStyleSnapshotSchema,
} from "@workbench/workbench-contracts";
import { DesignPresetsService } from "../src/modules/design-presets/design-presets.service.js";
import { RunsService } from "../src/modules/runs/runs.service.js";

describe("DesignPresetsService", () => {
  it("serves the four immutable, canonically checksummed presets", () => {
    const service = new DesignPresetsService();
    const catalog = designPresetCatalogSchema.parse(service.list());

    expect(catalog.items.map((item) => item.presetId)).toEqual([
      "workbench.alexandria",
      "workbench.bauhaus",
      "workbench.glacier",
      "workbench.carbon",
    ]);
    for (const item of catalog.items) {
      const checksum = createHash("sha256")
        .update(canonicalJson(designPresetDefinitionFromCatalogItem(item)))
        .digest("hex");
      expect(item.checksum).toBe(checksum);
      expect(item.directives.composition.length).toBeGreaterThan(20);
      expect(item.tokens.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.isFrozen(service.list())).toBe(true);
    expect(Object.isFrozen(service.list().items[0]!.tokens.colors)).toBe(true);
  });

  it("resolves only an exact id, version, and checksum", () => {
    const service = new DesignPresetsService();
    const item = service.list().items[0]!;
    const reference = { presetId: item.presetId, version: item.version, checksum: item.checksum };
    expect(service.resolve(reference)).toBe(item);

    expect(() => service.resolve({ ...reference, presetId: "workbench.unknown" })).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ code: "RUN_DESIGN_PRESET_UNKNOWN" }),
      }),
    );
    expect(() => service.resolve({ ...reference, version: item.version + 1 })).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ code: "RUN_DESIGN_PRESET_VERSION_MISMATCH" }),
      }),
    );
    expect(() => service.resolve({ ...reference, checksum: "0".repeat(64) })).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ code: "RUN_DESIGN_PRESET_CHECKSUM_MISMATCH" }),
      }),
    );
  });

  it("materializes the full preset snapshot and its independent Run hash", async () => {
    const designPresets = new DesignPresetsService();
    const item = designPresets.list().items[1]!;
    const runs = new RunsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      designPresets,
    ) as unknown as {
      resolveDesignStyle(
        tx: unknown,
        projectId: string,
        style: { kind: "preset"; presetId: string; version: number; checksum: string },
      ): Promise<{ artifactVersionId: null; snapshot: unknown; snapshotSha256: string }>;
    };

    const resolved = await runs.resolveDesignStyle({}, "project_unused", {
      kind: "preset",
      presetId: item.presetId,
      version: item.version,
      checksum: item.checksum,
    });
    const snapshot = runtimePresetDesignStyleSnapshotSchema.parse(resolved.snapshot);

    expect(resolved.artifactVersionId).toBeNull();
    expect(snapshot).toMatchObject({
      source: { presetId: item.presetId, version: item.version, checksum: item.checksum },
      directives: item.directives,
      tokens: item.tokens,
    });
    expect(resolved.snapshotSha256).toBe(
      createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    );
    expect(resolved.snapshotSha256).not.toBe(item.checksum);
  });

  it("rejects an invalid preset before model discovery or a write transaction", async () => {
    const designPresets = new DesignPresetsService();
    const runtimeModels = { assertAvailable: vi.fn() };
    const db = {
      run: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(),
    };
    const runs = new RunsService(
      db as never,
      {
        findThread: vi.fn(async () => ({
          id: "thread_1",
          projectId: "project_1",
          project: { id: "project_1", workspaceId: "workspace_1" },
        })),
      } as never,
      {} as never,
      {} as never,
      runtimeModels as never,
      designPresets,
    );

    await expect(runs.start("principal_1", "thread_1", "preset-invalid-123", {
      prompt: "Build it",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: {
        kind: "preset",
        presetId: "workbench.unknown",
        version: 1,
        checksum: "0".repeat(64),
      },
      sourceIds: [],
      artifactTargets: [],
      requestedArtifactKinds: [],
    })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: "RUN_DESIGN_PRESET_UNKNOWN" }),
    });
    expect(runtimeModels.assertAvailable).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

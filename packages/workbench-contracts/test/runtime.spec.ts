import { describe, expect, expectTypeOf, it } from "vitest";

import {
  runtimeResultSchema,
  type RuntimeArtifactDraft,
  type RuntimeProgressEvent,
} from "../src/runtime.js";
import {
  runtimePrototypePatchInputSchema,
  type RuntimePrototypePatchInput,
} from "../src/prototype-patches.js";

const target = {
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenIds: [],
};

describe("Runtime result publication contract", () => {
  it("requires an explicit create or revise operation", () => {
    const create = {
      protocol: "workbench.runtime.result.v1" as const,
      message: "done",
      artifacts: [{
        kind: "document" as const,
        schemaVersion: 1,
        title: "Notes",
        operation: { kind: "create" as const },
        citations: [{
          id: "citation-1", documentId: "doc-1", chunkId: "chunk-1", sourcePath: "00-rules/notes.md",
          title: "Notes", quote: "notes", locator: { heading: "Notes", startLine: null, endLine: null },
        }],
        content: { text: "notes" },
      }],
    };
    expect(runtimeResultSchema.parse(create)).toEqual(create);
    expect(runtimeResultSchema.safeParse({
      ...create, artifacts: [{ ...create.artifacts[0], citations: [] }],
    }).success).toBe(false);
    expect(runtimeResultSchema.safeParse({
      ...create,
      artifacts: create.artifacts.map(({ operation: _operation, ...artifact }) => artifact),
    }).success).toBe(false);
  });

  it("rejects revising the same Artifact twice in one result", () => {
    const artifact = {
      kind: "document" as const,
      schemaVersion: 1,
      title: "Notes",
      operation: { kind: "revise" as const, target },
      citations: [],
      content: { text: "notes" },
    };
    expect(runtimeResultSchema.safeParse({
      protocol: "workbench.runtime.result.v1",
      message: "done",
      artifacts: [artifact, { ...artifact, operation: {
        kind: "revise",
        target: { ...target, artifactVersionId: "version-2" },
      } }],
    }).success).toBe(false);
  });
});

describe("Runtime generation progress contract", () => {
  it("carries a stable source event identity with an explicit generation stage", () => {
    type GenerationStageProgress = Extract<RuntimeProgressEvent, { type: "generation.stage" }>;
    const progress: GenerationStageProgress = {
      type: "generation.stage",
      stage: "screen-streaming",
      sourceEventId: "tool-call-1",
    };

    expect(progress).toEqual({
      type: "generation.stage",
      stage: "screen-streaming",
      sourceEventId: "tool-call-1",
    });
    expectTypeOf<GenerationStageProgress>().toEqualTypeOf<{
      type: "generation.stage";
      stage:
        | "thinking"
        | "design-system"
        | "mapping-components"
        | "creating-flows"
        | "generating-ui"
        | "screen-streaming"
        | "summarizing"
        | "screen-stable";
      sourceEventId: string;
    }>();
  });

  it("carries a validated Artifact draft with its stable source event identity", () => {
    type ArtifactDraftProgress = Extract<RuntimeProgressEvent, { type: "artifact.draft" }>;
    const draft: RuntimeArtifactDraft = {
      kind: "document",
      schemaVersion: 1,
      title: "Working notes",
      operation: { kind: "create" },
      citations: [],
      content: { text: "draft" },
    };
    const progress: ArtifactDraftProgress = {
      type: "artifact.draft",
      artifactIndex: 0,
      sourceEventId: "tool-call-draft-1",
      draft,
      checkpointScreens: [],
    };

    expect(progress).toEqual({
      type: "artifact.draft",
      artifactIndex: 0,
      sourceEventId: "tool-call-draft-1",
      draft,
      checkpointScreens: [],
    });
    expectTypeOf<ArtifactDraftProgress>().toEqualTypeOf<{
      type: "artifact.draft";
      artifactIndex: number;
      sourceEventId: string;
      draft: RuntimeArtifactDraft;
      checkpointScreens: Array<{ screenId: string; revision: number; checksum: string }>;
    }>();
  });

  it("keeps trusted Prototype patch input separate from adapter-derived source identity", () => {
    const patch: RuntimePrototypePatchInput = {
      protocol: "workbench.runtime.prototype-patch.v1",
      artifactIndex: 0,
      screenId: "screen-a",
      baseRevision: 3,
      nextRevision: 4,
      operations: [{ kind: "remove_node", nodeId: "node-a" }],
      resultingChecksum: "a".repeat(64),
    };
    type PatchProgress = Extract<RuntimeProgressEvent, { type: "artifact.prototype.patch" }>;
    const progress: PatchProgress = {
      type: "artifact.prototype.patch",
      sourceEventId: "adapter-tool-call-1",
      patch,
    };

    expect(runtimePrototypePatchInputSchema.parse(patch)).toEqual(patch);
    expect(runtimePrototypePatchInputSchema.safeParse({ ...patch, sourceEventId: "forged" }).success)
      .toBe(false);
    expect(runtimePrototypePatchInputSchema.safeParse({ ...patch, artifactIndex: 20 }).success)
      .toBe(false);
    expect(progress.sourceEventId).toBe("adapter-tool-call-1");
    expectTypeOf<PatchProgress>().toEqualTypeOf<{
      type: "artifact.prototype.patch";
      sourceEventId: string;
      patch: RuntimePrototypePatchInput;
    }>();
  });
});

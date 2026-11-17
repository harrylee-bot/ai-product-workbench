// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearStudioComposerSessions,
  readComposerSession,
  useStudioComposerSession,
  type ComposerContext,
} from "./composer-session";

afterEach(async () => {
  cleanup();
  await clearStudioComposerSessions();
  sessionStorage.clear();
});
const artifact: ComposerContext = {
  kind: "artifact",
  key: "artifact:version-one",
  title: "文档版本一",
  artifact: {
    title: "文档版本一",
    workflow: "edit",
    artifactTargets: [
      {
        artifactId: "artifact-one",
        artifactVersionId: "version-one",
        screenIds: [],
      },
    ],
    requestedArtifactKinds: ["prd"],
  },
};

describe("Studio composer context and recovery", () => {
  it("ignores old prompt storage while restoring inputs written by the new composer", async () => {
    const legacyKey = "workbench:studio:account-one:project-one:prompt";
    sessionStorage.setItem(legacyKey, "old system prompt");
    const first = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    expect(first.result.current.entry.draft.prompt).toBe("");
    act(() =>
      first.result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "new system draft",
      })),
    );
    await waitFor(async () =>
      expect(
        (await readComposerSession("account-one:project-one"))?.entries.new
          .draft.prompt,
      ).toBe("new system draft"),
    );
    first.unmount();
    const restored = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(restored.result.current.ready).toBe(true));
    expect(restored.result.current.entry.draft.prompt).toBe("new system draft");
    expect(sessionStorage.getItem(legacyKey)).toBe("old system prompt");
  });
  it("persists only attachment state, replacing a prepared file with its authorized source reference", async () => {
    const { result } = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    const file = new File(["private file bytes"], "requirements.txt", {
      type: "text/plain",
    });
    act(() =>
      result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "有附件的需求",
        files: [file],
      })),
    );
    await waitFor(async () => {
      const stored = await readComposerSession("account-one:project-one");
      expect(stored?.entries.new?.draft.files).toEqual([]);
      expect(stored?.entries.new?.draft.missingFiles).toEqual([
        {
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
        },
      ]);
    });
    act(() => result.current.bindFileSource("new", file, "authorized-source"));
    await waitFor(async () => {
      const stored = await readComposerSession("account-one:project-one");
      expect(stored?.entries.new?.draft.sourceIds).toEqual([
        "authorized-source",
      ]);
      expect(stored?.entries.new?.draft.missingFiles).toEqual([]);
    });
  });
  it("isolates account/project drafts and restores exact target and selections after remount", async () => {
    const first = renderHook(
      ({ project }) => useStudioComposerSession("account-one", project),
      { initialProps: { project: "project-one" } },
    );
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    act(() =>
      first.result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "独立计划",
        modelId: "fixed-model",
        sourceIds: ["source-one"],
        targetSurface: "app",
      })),
    );
    act(() => first.result.current.switchTo(artifact, "继续完善"));
    act(() =>
      first.result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "待保存的文档修改",
        designStyle: {
          kind: "preset",
          presetId: "preset-one",
          version: 3,
          checksum: "a".repeat(64),
        },
      })),
    );
    await waitFor(async () =>
      expect(
        (await readComposerSession("account-one:project-one"))?.activeKey,
      ).toBe(artifact.key),
    );
    first.rerender({ project: "project-two" });
    expect(first.result.current.entry.draft.prompt).toBe("");
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    act(() =>
      first.result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "第二项目",
      })),
    );
    first.unmount();
    const restored = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(restored.result.current.ready).toBe(true));
    expect(restored.result.current.entry.context).toEqual(artifact);
    expect(restored.result.current.entry.draft).toMatchObject({
      prompt: "待保存的文档修改",
      designStyle: { version: 3 },
    });
    act(() =>
      restored.result.current.switchTo(restored.result.current.newContext),
    );
    expect(restored.result.current.entry.draft).toMatchObject({
      prompt: "独立计划",
      modelId: "fixed-model",
      sourceIds: ["source-one"],
      targetSurface: "app",
    });
    const other = renderHook(() =>
      useStudioComposerSession("account-two", "project-one"),
    );
    await waitFor(() => expect(other.result.current.ready).toBe(true));
    expect(other.result.current.entry.draft.prompt).toBe("");
  });

  it("retains input typed during an async context load and ignores a response for an abandoned context", async () => {
    const { result } = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() =>
      result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "在读取时继续输入",
      })),
    );
    act(() =>
      result.current.switchTo(artifact, "stale text", {
        inheritPrompt: true,
        fromKey: "new",
      }),
    );
    expect(result.current.entry.draft.prompt).toBe("在读取时继续输入");
    act(() =>
      result.current.switchTo({ ...artifact, key: "abandoned" }, "", {
        inheritPrompt: true,
        fromKey: "new",
      }),
    );
    expect(result.current.entry.context.key).toBe(artifact.key);
  });

  it("keeps the next prompt when completion races with editing and clears private sessions on logout", async () => {
    const { result } = renderHook(() =>
      useStudioComposerSession("account-one", "project-one"),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.switchTo(artifact, "已提交"));
    const submitted = result.current.entry.draft;
    act(() =>
      result.current.updateDraft((draft) => ({
        ...draft,
        prompt: "下一次修改",
      })),
    );
    act(() => result.current.complete(artifact.key, submitted));
    expect(result.current.entry.draft.prompt).toBe("下一次修改");
    act(() => window.dispatchEvent(new Event("workbench:logout")));
    await clearStudioComposerSessions();
    expect(result.current.ready).toBe(false);
    expect(result.current.entry.draft.prompt).toBe("");
    expect(
      await readComposerSession("account-one:project-one"),
    ).toBeUndefined();
  });
});

it("keeps a fixed artifact discussion active after accepted text without erasing later edits", async () => {
  const { result } = renderHook(() =>
    useStudioComposerSession("account-one", "project-one"),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.switchTo(artifact, "本次需求"));
  const submitted = result.current.entry.draft;
  act(() => result.current.complete(artifact.key, submitted, true));
  expect(result.current.entry.context.key).toBe(artifact.key);
  expect(result.current.entry.draft.prompt).toBe("");
  expect(result.current.entry.context.kind).toBe("artifact");
});

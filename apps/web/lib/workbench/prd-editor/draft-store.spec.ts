// @vitest-environment jsdom
import { prdDocumentV2Example } from "@workbench/workbench-contracts/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrdDraftStore } from "./draft-store";

const reference = { projectId: "project-1", artifactId: "prd-1", artifactVersionId: "v1" };
const baseline = prdDocumentV2Example;
function changed(author = "修改后的作者") {
  const document = structuredClone(baseline);
  document.versionHistory[0]!.author = author;
  return document;
}

beforeEach(() => localStorage.clear());

describe("PRD drafts", () => {
  it("restores unsaved content after remount and isolates principals and projects", () => {
    const store = new PrdDraftStore(localStorage, "principal-a");
    store.update(reference, baseline, changed());
    const restored = new PrdDraftStore(localStorage, "principal-a");
    expect(restored.get(reference)?.document).toEqual(changed());
    expect(restored.get({ ...reference, projectId: "project-2" })).toBeUndefined();
    expect(new PrdDraftStore(localStorage, "principal-b").get(reference)).toBeUndefined();
    restored.discard(reference);
    expect(new PrdDraftStore(localStorage, "principal-a").get(reference)).toBeUndefined();
  });

  it("preserves a temporarily empty required field across reload for correction", () => {
    const store = new PrdDraftStore(localStorage, "principal-a");
    store.update(reference, baseline, changed(""));
    expect(new PrdDraftStore(localStorage, "principal-a").get(reference)?.document).toEqual(changed(""));
  });

  it("keeps independent drafts when the canvas contains two versions of the same artifact", () => {
    const store = new PrdDraftStore(localStorage, "principal-a");
    const otherVersion = { ...reference, artifactVersionId: "v2" };
    store.update(reference, baseline, changed("版本一草稿"));
    expect(store.get(otherVersion)).toBeUndefined();
    store.update(otherVersion, baseline, changed("版本二草稿"));
    const restored = new PrdDraftStore(localStorage, "principal-a");
    expect(restored.get(reference)?.document).toEqual(changed("版本一草稿"));
    expect(restored.get(otherVersion)?.document).toEqual(changed("版本二草稿"));
    restored.discard(otherVersion);
    expect(restored.get(reference)?.document).toEqual(changed("版本一草稿"));
  });

  it("shares an in-flight save between the editor and the publication barrier", async () => {
    let finish!: (version: string) => void;
    const commit = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const store = new PrdDraftStore();
    store.registerProject(reference.projectId, commit);
    store.update(reference, baseline, changed());
    const manual = store.save(reference);
    const barrier = store.saveProject(reference.projectId);
    expect(commit).toHaveBeenCalledOnce();
    expect(store.get(reference)?.saving).toBe(true);
    finish("v2");
    await expect(manual).resolves.toEqual({ ...reference, savedArtifactVersionId: "v2" });
    await expect(barrier).resolves.toEqual([{ ...reference, savedArtifactVersionId: "v2" }]);
    expect(store.hasDrafts()).toBe(false);
  });

  it("keeps rejected content and replays the same prepared revision when retried", async () => {
    const store = new PrdDraftStore(localStorage, "principal-a");
    const commit = vi.fn().mockRejectedValueOnce(new Error("保存失败")).mockResolvedValue("v2");
    store.registerProject(reference.projectId, commit);
    store.update(reference, baseline, changed());
    await expect(store.saveProject(reference.projectId)).rejects.toThrow("保存失败");
    expect(store.get(reference)).toMatchObject({ document: changed(), error: "保存失败", saving: false });
    const restored = new PrdDraftStore(localStorage, "principal-a");
    restored.registerProject(reference.projectId, commit);
    await restored.saveProject(reference.projectId);
    expect(commit.mock.calls[0]?.[1]).toEqual(commit.mock.calls[1]?.[1]);
    expect(restored.hasDrafts()).toBe(false);
  });
});

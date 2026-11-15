// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrototypeRevision } from "@workbench/workbench-contracts";
import { WorkbenchPrototypeV2Panel, readPrototypeSelection } from "./workbench-prototype-v2-panel";
import type { WorkbenchProjectComposerProps } from "./workbench-project-composer";

const state = vi.hoisted(() => ({
  plan: undefined as any, plans: undefined as any[] | undefined, revisions: [] as any[], feedback: [] as any[], shares: [] as any[], exports: [] as any[],
  direct: vi.fn(), createFeedback: vi.fn(), revise: vi.fn(), createPlan: vi.fn(), generic: vi.fn(), composer: undefined as any,
}));
vi.mock("./workbench-project-composer", () => ({ ProjectComposer: (props: any) => { state.composer = props; return <div data-testid="shared-composer">{props.intentControl}Project Composer</div>; } }));
vi.mock("@/lib/workbench/features", () => {
  const mutation = () => ({ mutateAsync: state.generic, isPending: false });
  return {
    useWorkbenchPrototypeV2Plans: () => ({ data: state.plans ?? (state.plan ? [state.plan] : []) }),
    useWorkbenchPrototypeV2Plan: (_: string, id: string) => { const value = (state.plans ?? (state.plan ? [state.plan] : [])).find((plan) => plan.id === id); return { data: value ? { value } : undefined }; },
    useWorkbenchPrototypeV2Revision: (_: string, id: string) => { state.direct(id); return { data: state.revisions.find((revision) => revision.id === id) ? { value: state.revisions.find((revision) => revision.id === id) } : undefined }; },
    useWorkbenchPrototypeV2Revisions: () => ({ data: state.revisions.map(({ pages: _pages, previewHtml: _preview, ...summary }) => summary) }),
    useWorkbenchPrototypeV2RevisionDiff: () => ({ data: { sourceRevisionId: "revision-zero", pages: [{ pageId: "screen-home", change: "changed" }, { pageId: "screen-details", change: "unchanged" }] } }),
    useWorkbenchPrototypeV2Feedback: () => ({ data: state.feedback }),
    useWorkbenchPrototypeV2Shares: () => ({ data: state.shares }), useWorkbenchPrototypeV2Exports: () => ({ data: state.exports }),
    useCreateWorkbenchPrototypeV2Feedback: () => ({ mutateAsync: state.createFeedback, isPending: false }),
    useReviseWorkbenchPrototypeV2Revision: () => ({ mutateAsync: state.revise, isPending: false }),
    useCreateWorkbenchPrototypeV2Export: mutation, useCreateWorkbenchPrototypeV2PreviewToken: mutation,
    useCreateWorkbenchPrototypeV2Share: mutation, useCancelWorkbenchPrototypeV2Export: mutation,
    useDownloadWorkbenchPrototypeV2Export: mutation, useResolveWorkbenchPrototypeV2Feedback: mutation,
    useRevokeWorkbenchPrototypeV2Share: mutation, useReviewWorkbenchPrototypeV2Revision: mutation,
    useRetryWorkbenchPrototypeV2Export: mutation, usePrototypeV2PlanAction: mutation, useRetryWorkbenchPrototypeV2Plan: mutation,
  };
});

const timestamp = "2026-11-15T00:00:00.000Z";
function revision(id = "revision-one", version = 1): PrototypeRevision {
  return { id, projectId: "project-one", planId: "plan-one", sourceRevisionId: null, version, revision: 7, title: `Prototype ${version}`, status: "ready", documentSha256: "a".repeat(64), createdById: "person-one", createdAt: timestamp, updatedAt: timestamp, failure: null, previewHtml: '<!doctype html><html><head></head><body><button data-wb-node="save">Frozen Save</button></body></html>',
    pages: [{ id: "screen-home", slug: "home", route: "/", order: 0, title: "Home", content: '<button data-wb-node="save">Save</button>', sha256: "b".repeat(64) }, { id: "screen-details", slug: "details", route: "/details", order: 1, title: "Details", content: "<p>Details</p>", sha256: "c".repeat(64) }] };
}
const composer = { busy: false, disabled: false, onSubmitPrompt: vi.fn(), setPrompt: vi.fn() } as unknown as WorkbenchProjectComposerProps;
function show() { return render(<WorkbenchPrototypeV2Panel projectId="project-one" canEdit composer={composer} onCreatePlan={state.createPlan} onClose={vi.fn()} />); }
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, "", "/projects/project-one?prototypePlan=plan-one&prototypeRevision=revision-one&prototypePage=screen-details");
  state.plan = { id: "plan-one", projectId: "project-one", rootPlanId: null, sourceRevisionId: null, contentVersion: 1, revision: 3, title: "Original plan", prompt: "Create a prototype", status: "ready", failure: null };
  state.plans = undefined; state.revisions = [revision()]; state.feedback = []; state.shares = []; state.exports = [];
  state.createFeedback.mockReset().mockResolvedValue({ value: { id: "feedback-from-composer" } }); state.generic.mockResolvedValue({}); state.createPlan.mockResolvedValue(state.plan);
  state.revise.mockReset().mockResolvedValue({ value: { ...state.plan, id: "plan-two", rootPlanId: "plan-one", sourceRevisionId: "revision-one", contentVersion: 2, status: "approved" } });
});
afterEach(cleanup);

describe("V2 project interaction", () => {
  it("restores plan, revision and page from a copied URL and preserves other query state", async () => {
    window.history.replaceState(null, "", window.location.href + "&board=keep");
    show();
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-pressed")).toBe("true");
    expect(state.direct).toHaveBeenCalledWith("revision-one");
    expect(screen.getByTitle("Prototype 1").getAttribute("srcdoc")).toContain("Frozen Save");
    expect(screen.getByTitle("Prototype 1").getAttribute("srcdoc")).not.toContain("<p>Details</p>");
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(readPrototypeSelection(window.location.search)).toEqual({ planId: "plan-one", revisionId: "revision-one", pageId: "screen-home" }));
    expect(new URLSearchParams(window.location.search).get("board")).toBe("keep");
  });
  it("resolves a revision-only link and selects a newly available revision without an extra history click", async () => {
    window.history.replaceState(null, "", "/projects/project-one?prototypeRevision=revision-one&prototypePage=screen-details");
    const view = show();
    await waitFor(() => expect(readPrototypeSelection(window.location.search).planId).toBe("plan-one"));
    view.unmount();
    window.history.replaceState(null, "", "/projects/project-one?prototypePlan=plan-one");
    show();
    await waitFor(() => expect(readPrototypeSelection(window.location.search).revisionId).toBe("revision-one"));
    expect(screen.getByRole("button", { name: /版本 1 · 待确认/ })).toBeTruthy();
  });
  it("saves anchored feedback from the selected iframe element and rejects unrelated windows", async () => {
    show(); const iframe = screen.getByTitle("Prototype 1") as HTMLIFrameElement;
    const payload = { type: "workbench-prototype-v2:interaction", event: "click", target: 'button[data-wb-node="save"]', tag: "button", label: "Save", pageId: "screen-details" };
    act(() => window.dispatchEvent(new MessageEvent("message", { source: window, origin: "null", data: payload })));
    expect(screen.queryByRole("button", { name: "取消定位" })).toBeNull();
    act(() => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "null", data: payload })));
    fireEvent.change(screen.getByRole("textbox", { name: "当前版本批注" }), { target: { value: "Change the save label" } });
    fireEvent.click(screen.getByRole("button", { name: "保存批注" }));
    await waitFor(() => expect(state.createFeedback).toHaveBeenCalledWith({ request: { body: "Change the save label", anchor: { pageId: "screen-details", selector: 'button[data-wb-node="save"]', quote: "Save" } } }));
  });
  it("restores the generating child from revision-only and root/revision links after a failed plan retry", async () => {
    state.plan = { ...state.plan, status: "failed", revision: 20 };
    const child = { ...state.plan, id: "plan-retry", rootPlanId: "plan-one", contentVersion: 2, revision: 9, status: "ready", title: "Retried plan" };
    state.plans = [child, state.plan]; state.revisions = [{ ...revision(), status: "failed" }, revision("revision-two", 2)];
    for (const search of ["prototypeRevision=revision-two", "prototypePlan=plan-one&prototypeRevision=revision-two"]) {
      window.history.replaceState(null, "", `/projects/project-one?${search}&prototypePage=screen-details`);
      const view = show();
      await waitFor(() => expect(readPrototypeSelection(window.location.search)).toEqual({ planId: "plan-retry", revisionId: "revision-two", pageId: "screen-details" }));
      expect(screen.getByText("计划状态：生成完成")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "重试生成" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /版本 1 · 失败/ }));
      await waitFor(() => expect(readPrototypeSelection(window.location.search).planId).toBe("plan-one"));
      view.unmount();
    }
  });
  it("keeps an active child plan while its previous immutable revision remains selected", () => {
    const child = { ...state.plan, id: "plan-two", rootPlanId: "plan-one", contentVersion: 2, status: "generating" };
    state.plans = [child, state.plan];
    window.history.replaceState(null, "", "/projects/project-one?prototypePlan=plan-two&prototypeRevision=revision-one&prototypePage=screen-home");
    show();
    expect(readPrototypeSelection(window.location.search).planId).toBe("plan-two");
    expect(screen.getByRole("button", { name: "取消生成" })).toBeTruthy();
  });
  it("loads saved feedback/share/export history and uses open feedback to generate the next version", async () => {
    state.feedback = [{ id: "feedback-one", projectId: "project-one", revisionId: "revision-one", revision: 2, body: "Saved comment", status: "open", anchor: null }];
    state.shares = [{ id: "share-one", revisionId: "revision-one", revision: 1, status: "active", url: "https://example.test/prototype-share/token" }];
    state.exports = [{ id: "export-one", revisionId: "revision-one", revision: 3, format: "react", status: "succeeded", artifact: { downloadUrl: "https://example.test/file" } }];
    show();
    expect(screen.getByText("Saved comment")).toBeTruthy(); expect(screen.getByRole("link", { name: "打开分享链接" }).getAttribute("href")).toContain("token");
    expect(screen.getByText("REACT · 已完成")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "根据未解决批注生成新版本" }));
    await waitFor(() => expect(state.revise).toHaveBeenCalledWith({ ifMatch: '"7"', request: { feedbackIds: ["feedback-one"] } }));
    await waitFor(() => expect(readPrototypeSelection(window.location.search).planId).toBe("plan-two"));
  });
  it("uses the existing Composer submission with model and attachment context intact for an explicit new plan", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "新建计划" }));
    const submission = { prompt: "New prototype", modelChoiceKey: "model-one", requestedArtifactKinds: ["prototype"], sourceIds: ["source-one"], designStyle: { kind: "automatic" }, files: [new File(["doc"], "requirements.txt")], targetSurface: "desktop" };
    await act(async () => { await state.composer.onSubmitPrompt(submission); });
    expect(state.createPlan).toHaveBeenCalledWith(submission);
    expect(screen.getAllByTestId("shared-composer")).toHaveLength(1);
    expect(screen.queryByPlaceholderText("描述页面、控件和交互状态")).toBeNull();
  });
  it("revises the selected immutable version from the same bottom Composer and retries without duplicating feedback", async () => {
    show();
    expect(screen.getByRole("button", { name: "修改当前版本 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(state.composer.generationContextLocked).toBe(true);
    const submission = { prompt: "Make this button blue", modelChoiceKey: "model-one", requestedArtifactKinds: ["prd", "prototype"], targetSurface: "desktop", sourceIds: [], files: [], designStyle: { kind: "automatic" } };
    state.revise.mockRejectedValueOnce(new Error("Response lost"));
    await act(async () => { expect(await state.composer.onSubmitPrompt(submission)).toBeNull(); });
    await act(async () => { const result = await state.composer.onSubmitPrompt(submission); expect(result, screen.queryByRole("alert")?.textContent ?? "").toBe("plan-two"); });
    expect(state.createPlan).not.toHaveBeenCalled();
    expect(state.createFeedback).toHaveBeenCalledTimes(1);
    expect(state.createFeedback.mock.calls[0]![0]).toMatchObject({ request: { body: "Make this button blue", anchor: { pageId: "screen-details" } } });
    expect(state.revise.mock.calls[0]).toEqual(state.revise.mock.calls[1]);
    expect(state.revise.mock.calls[0]![0]).toMatchObject({ ifMatch: '"7"', request: { feedbackIds: ["feedback-from-composer"], prompt: "Make this button blue" } });
    expect(readPrototypeSelection(window.location.search)).toEqual({ planId: "plan-two", revisionId: "revision-one", pageId: "screen-details" });
  });

  it("uses the same Composer for initial generation and then a revision after the first result arrives", async () => {
    const plan = state.plan;
    state.plan = undefined; state.revisions = [];
    window.history.replaceState(null, "", "/projects/project-one?prototype=1");
    state.createPlan.mockResolvedValue(plan);
    const view = show();
    const initial = { prompt: "Create PRD and prototype", modelChoiceKey: "model-one", requestedArtifactKinds: ["prd", "prototype"], targetSurface: "desktop" };
    await act(async () => { expect(await state.composer.onSubmitPrompt(initial)).toBe("plan-one"); });
    expect(state.createPlan).toHaveBeenCalledWith(initial);
    state.plan = plan; state.revisions = [revision()];
    view.rerender(<WorkbenchPrototypeV2Panel projectId="project-one" canEdit composer={composer} onCreatePlan={state.createPlan} onClose={vi.fn()} />);
    await waitFor(() => expect(state.composer.generationContextLocked).toBe(true));
    await act(async () => { expect(await state.composer.onSubmitPrompt({ ...initial, prompt: "Make the button blue" })).toBe("plan-two"); });
    expect(state.createPlan).toHaveBeenCalledTimes(1);
    expect(state.revise).toHaveBeenCalledWith(expect.objectContaining({ request: { feedbackIds: ["feedback-from-composer"], prompt: "Make the button blue" } }));
  });

  it("shows the server semantic diff instead of treating the full HTML package checksum as a page change", () => {
    show();
    expect(screen.getByText("修改页面 · Home")).toBeTruthy();
    expect(screen.queryByText("修改页面 · Details")).toBeNull();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectComposer } from "./workbench-project-composer";

const editChoice = {
  description: "Edit the selected immutable Artifact version.",
  key: "workflow:edit:quality",
  label: "Edit",
  modelId: "quality",
  workflow: "edit" as const,
};

const createChoice = {
  description: "Create a new product Artifact.",
  key: "workflow:create:quality",
  label: "Create",
  modelId: "quality",
  workflow: "generate" as const,
};

const artifactTargets = [{
  artifactId: "artifact-1",
  artifactVersionId: "version-1",
  screenIds: ["screen-home", "screen-success"],
}];

afterEach(cleanup);

describe("Project Composer Edit workflow", () => {
  it("cannot submit Edit without a valid Artifact target", () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({ editArtifactTargets: [], onSubmitPrompt });

    const submit = screen.getByRole("button", { name: "提交项目请求" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });

  it("submits the exact selected ArtifactVersion and screen targets", async () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({ editArtifactTargets: artifactTargets, onSubmitPrompt });

    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactTargets,
        modelChoiceKey: editChoice.key,
        prompt: "Change the selected screens",
      }),
    ));
  });

  it("never leaks the selected Artifact targets into a non-Edit submission", async () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({ choice: createChoice, editArtifactTargets: artifactTargets, onSubmitPrompt });

    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactTargets: [],
        modelChoiceKey: createChoice.key,
      }),
    ));
  });

  it("submits frozen targets only for an explicit targeted Generate context", async () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({
      choice: createChoice,
      context: {
        artifactTargets,
        id: "prototype:screen-home",
        kind: "generate-prototype",
        label: "生成原型：2 个界面",
      },
      editArtifactTargets: [],
      onSubmitPrompt,
      prompt: "Turn these selected designs into an interactive flow",
    });

    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactTargets,
        generationIntent: "interactive-prototype",
        modelChoiceKey: createChoice.key,
        requestedArtifactKinds: ["prototype"],
      }),
    ));
  });

  it("keeps the selected-screen Generate follow-up explicit while the plain composer stays targetless", async () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({
      choice: createChoice,
      context: {
        artifactTargets,
        id: "followup:screen-home",
        kind: "generate-followup",
        label: "后续设计：Home",
      },
      editArtifactTargets: [],
      onSubmitPrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactTargets,
        generationIntent: "followup-design",
        requestedArtifactKinds: ["prototype"],
      }),
    ));
  });

  it("drops frozen Generate targets as soon as the explicit context is cleared", async () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    const context = {
      artifactTargets,
      id: "prototype:screen-home",
      kind: "generate-prototype" as const,
      label: "生成原型：2 个界面",
    };
    const rendered = renderComposer({
      choice: createChoice,
      context,
      editArtifactTargets: [],
      onSubmitPrompt,
    });

    rendered.rerender(projectComposerElement({
      choice: createChoice,
      editArtifactTargets: artifactTargets,
      onSubmitPrompt,
    }));
    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));

    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ artifactTargets: [] }),
    ));
  });

  it("cannot submit a targeted Generate without explicit screen ids", () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({
      choice: createChoice,
      context: {
        artifactTargets: [{ ...artifactTargets[0]!, screenIds: [] }],
        id: "prototype:whole-version",
        kind: "generate-prototype",
        label: "生成原型",
      },
      editArtifactTargets: [],
      onSubmitPrompt,
    });

    expect((screen.getByRole("button", { name: "提交项目请求" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("shows a typed selection context, focuses the prompt, and clears it after acceptance", async () => {
    const onClearContext = vi.fn();
    const onSubmitPrompt = vi.fn(async () => "run-1");
    renderComposer({
      context: {
        artifactTargets,
        id: "screen-node",
        kind: "agent-edit",
        label: "修改：Home",
      },
      editArtifactTargets: artifactTargets,
      focusRequest: 1,
      onClearContext,
      onSubmitPrompt,
    });

    expect(screen.getByRole("button", { name: "移除选择上下文 修改：Home" })).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("您想更改或创建什么内容?"));
    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));

    await waitFor(() => expect(onClearContext).toHaveBeenCalledOnce());
  });
});

describe("Project Composer PRD context", () => {
  it("collapses the command menu when clicking the blank prompt area", async () => {
    renderComposer({
      choice: createChoice,
      editArtifactTargets: [],
      onSubmitPrompt: vi.fn(async () => "run-1"),
    });

    fireEvent.click(screen.getByRole("button", { name: "命令" }));
    expect(screen.getByRole("menuitem", { name: "生成 UI 界面设计" })).not.toBeNull();

    fireEvent.mouseDown(screen.getByPlaceholderText("您想更改或创建什么内容?"));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "生成 UI 界面设计" })).toBeNull());
  });

  it("requests an explicit model-menu close when clicking the blank prompt area", () => {
    const onCloseModel = vi.fn();
    render(projectComposerElement({
      choice: createChoice,
      editArtifactTargets: [],
      modelMenuOpen: true,
      onCloseModel,
      onSubmitPrompt: vi.fn(async () => "run-1"),
    }));

    fireEvent.mouseDown(screen.getByPlaceholderText("您想更改或创建什么内容?"));
    expect(onCloseModel).toHaveBeenCalledOnce();
  });

  it("switches an Edit selection back to Generate for artifact output", () => {
    const onSelectModel = vi.fn();
    render(projectComposerElement({
      choice: editChoice,
      editArtifactTargets: [],
      modelChoices: [editChoice, createChoice],
      modelMenuOpen: true,
      onSelectModel,
      onSubmitPrompt: vi.fn(async () => "run-1"),
    }));

    fireEvent.click(screen.getByRole("menuitemradio", { name: /生成原型/ }));
    expect(onSelectModel).toHaveBeenCalledWith(createChoice.key);
  });

  it("removes the document context instead of leaving a no-op close button", () => {
    const onSubmitPrompt = vi.fn(async () => "run-1");
    render(<ProjectComposer
      busy={false}
      canRefresh={false}
      designPresetItems={[]}
      designPresetStatus="ready"
      disabled={false}
      editArtifactTargets={[]}
      model={createChoice.key}
      modelCatalog={{ error: null, retrying: false, status: "ready" }}
      modelChoices={[createChoice]}
      modelMenuOpen={false}
      onRefresh={vi.fn(async () => undefined)}
      onRetryDesignPresets={vi.fn()}
      onRetryModels={vi.fn()}
      onSelectModel={vi.fn()}
      onSubmitPrompt={onSubmitPrompt}
      onTargetSurfaceChange={vi.fn()}
      onToggleModel={vi.fn()}
      projectDesignSystemChoices={[]}
      projectId="project-1"
      projectMode="document"
      prompt=""
      runStatus={null}
      setPrompt={vi.fn()}
      targetSurface="web"
    />);

    const submit = screen.getByRole("button", { name: "提交项目请求" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "移除当前需求文档上下文" }));

    expect(screen.queryByText("当前需求文档")).toBeNull();
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
  });
});

describe("Project Composer session isolation", () => {
  it("clears the previous Project attachment without remounting the composer root", () => {
    const rendered = renderComposer({
      choice: createChoice,
      editArtifactTargets: [],
      onSubmitPrompt: vi.fn(async () => "run-1"),
    });
    const root = rendered.container.querySelector("[data-project-composer]");
    const input = rendered.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["p1"], "project-one.pdf", { type: "application/pdf" })] },
    });
    expect(screen.getByRole("button", { name: "移除附件 project-one.pdf" })).not.toBeNull();

    rendered.rerender(projectComposerElement({
      choice: createChoice,
      editArtifactTargets: [],
      onSubmitPrompt: vi.fn(async () => "run-2"),
      projectId: "project-2",
      prompt: "Project two prompt",
    }));

    expect(rendered.container.querySelector("[data-project-composer]")).toBe(root);
    expect(screen.queryByRole("button", { name: "移除附件 project-one.pdf" })).toBeNull();
  });

  it("does not clear the new Project draft when the previous submission resolves", async () => {
    const projectOneRun = deferred<string | null>();
    const projectOneSetPrompt = vi.fn();
    const projectTwoSetPrompt = vi.fn();
    const rendered = renderComposer({
      choice: createChoice,
      editArtifactTargets: [],
      onSubmitPrompt: vi.fn(() => projectOneRun.promise),
      setPrompt: projectOneSetPrompt,
    });

    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    rendered.rerender(projectComposerElement({
      choice: createChoice,
      editArtifactTargets: [],
      onSubmitPrompt: vi.fn(async () => "run-2"),
      projectId: "project-2",
      prompt: "Project two prompt",
      setPrompt: projectTwoSetPrompt,
    }));

    await act(async () => {
      projectOneRun.resolve("run-1");
      await projectOneRun.promise;
    });
    expect(projectOneSetPrompt).not.toHaveBeenCalled();
    expect(projectTwoSetPrompt).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("您想更改或创建什么内容?") as HTMLInputElement).value)
      .toBe("Project two prompt");
  });
});

function renderComposer({
  choice = editChoice,
  context,
  editArtifactTargets,
  focusRequest,
  onClearContext,
  onSubmitPrompt,
  projectId = "project-1",
  prompt = "Change the selected screens",
  setPrompt = vi.fn(),
}: {
  choice?: typeof editChoice | typeof createChoice;
  context?: Parameters<typeof ProjectComposer>[0]["context"];
  editArtifactTargets: typeof artifactTargets;
  focusRequest?: number;
  onClearContext?: () => void;
  onSubmitPrompt: (submission: Parameters<Parameters<typeof ProjectComposer>[0]["onSubmitPrompt"]>[0]) => Promise<string | null>;
  projectId?: string;
  prompt?: string;
  setPrompt?: (prompt: string) => void;
}) {
  return render(projectComposerElement({
    choice,
    context,
    editArtifactTargets,
    focusRequest,
    onClearContext,
    onSubmitPrompt,
    projectId,
    prompt,
    setPrompt,
  }));
}

function projectComposerElement({
  choice = editChoice,
  context,
  editArtifactTargets,
  focusRequest,
  modelChoices = [choice],
  modelMenuOpen = false,
  onClearContext,
  onCloseModel,
  onSubmitPrompt,
  onSelectModel = vi.fn(),
  onToggleModel = vi.fn(),
  projectId = "project-1",
  prompt = "Change the selected screens",
  setPrompt = vi.fn(),
}: {
  choice?: typeof editChoice | typeof createChoice;
  context?: Parameters<typeof ProjectComposer>[0]["context"];
  editArtifactTargets: typeof artifactTargets;
  focusRequest?: number;
  modelChoices?: Array<typeof editChoice | typeof createChoice>;
  modelMenuOpen?: boolean;
  onClearContext?: () => void;
  onCloseModel?: () => void;
  onSubmitPrompt: (submission: Parameters<Parameters<typeof ProjectComposer>[0]["onSubmitPrompt"]>[0]) => Promise<string | null>;
  onSelectModel?: (model: string) => void;
  onToggleModel?: () => void;
  projectId?: string;
  prompt?: string;
  setPrompt?: (prompt: string) => void;
}) {
  return <ProjectComposer
    busy={false}
    canRefresh={false}
    context={context}
    designPresetItems={[]}
    designPresetStatus="ready"
    disabled={false}
    editArtifactTargets={editArtifactTargets}
    focusRequest={focusRequest}
    model={choice.key}
    modelCatalog={{ error: null, retrying: false, status: "ready" }}
    modelChoices={modelChoices}
    modelMenuOpen={modelMenuOpen}
    onRefresh={vi.fn(async () => undefined)}
    onClearContext={onClearContext}
    onCloseModel={onCloseModel}
    onRetryDesignPresets={vi.fn()}
    onRetryModels={vi.fn()}
    onSelectModel={onSelectModel}
    onSubmitPrompt={onSubmitPrompt}
    onTargetSurfaceChange={vi.fn()}
    onToggleModel={onToggleModel}
    projectDesignSystemChoices={[]}
    projectId={projectId}
    projectMode="generated"
    prompt={prompt}
    runStatus={null}
    setPrompt={setPrompt}
    targetSurface="web"
  />;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

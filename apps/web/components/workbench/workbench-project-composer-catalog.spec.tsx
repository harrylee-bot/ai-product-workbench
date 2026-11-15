// @vitest-environment jsdom

import { cloneElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "@/lib/workbench/api";
import type { WorkbenchModelCatalogState } from "@/lib/workbench/features";
import { ProjectComposer } from "./workbench-project-composer";

vi.mock("@/lib/workbench/features/import-sources", async () => {
  const actual = await vi.importActual<typeof import("@/lib/workbench/features/import-sources")>("@/lib/workbench/features/import-sources");
  return {
    ...actual,
    useWorkbenchImportSources: () => ({
      data: { items: [] },
      error: null,
      isFetching: false,
      isPending: false,
      isSuccess: true,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("./workbench-import-sources-dialog", () => ({
  WorkbenchImportSourcesDialog: ({ open }: { open: boolean }) => (
    open ? <div data-testid="mock-import-sources-dialog" /> : null
  ),
}));

afterEach(cleanup);

// The output menu also exposes models from the live catalog.
describe("ProjectComposer catalog availability", () => {
  it.each<WorkbenchModelCatalogState>([
    { error: null, retrying: false, status: "loading" },
    { error: null, retrying: false, status: "empty" },
    ...[502, 504, 500].map(status => ({
      error: apiError(status), retrying: false, status: "error" as const,
    })),
    { error: apiError(504), retrying: true, status: "error" },
  ])("blocks opening and submitting while catalog is $status ($retrying)", catalog => {
    const onToggle = vi.fn();
    const onSubmit = vi.fn(async () => null);
    render(composer(catalog, onToggle, onSubmit));
    const picker = screen.getByRole("button", { name: "选择生成类型" });
    const submit = screen.getByRole("button", { name: "提交项目请求" });
    expect((picker as HTMLButtonElement).disabled).toBe(true);
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(picker);
    fireEvent.click(submit);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("restores the current generation menu when the catalog recovers", () => {
    const onToggle = vi.fn();
    const onSubmit = vi.fn(async () => null);
    const view = render(composer({ error: apiError(502), retrying: false, status: "error" }, onToggle, onSubmit));
    view.rerender(composer({ error: null, retrying: false, status: "ready" }, onToggle, onSubmit));
    const button = screen.getByRole("button", { name: "选择生成类型" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("submits the model explicitly selected from the catalog without changing output kinds", () => {
    const onSubmit = vi.fn(async () => null);
    const onSelect = vi.fn();
    const props = {
      modelMenuOpen: true,
      onSelectModel: onSelect,
      modelChoices: [
        { key: "generate", modelId: "quality", workflow: "generate" as const, label: "生成", description: "生成" },
        { key: "generate-pro", modelId: "deepseek-v4-pro", workflow: "generate" as const, label: "生成", description: "生成" },
      ],
    };
    const base = composer({ error: null, retrying: false, status: "ready" }, vi.fn(), onSubmit);
    const view = render(cloneElement(base, props));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "deepseek-v4-pro" }));
    expect(onSelect).toHaveBeenCalledWith("generate-pro");
    view.rerender(cloneElement(base, { ...props, model: "generate-pro", modelMenuOpen: false }));
    fireEvent.click(screen.getByRole("button", { name: "提交项目请求" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ modelChoiceKey: "generate-pro", requestedArtifactKinds: ["prd", "prototype"] }));
  });

});

function composer(catalog: WorkbenchModelCatalogState, onToggle: () => void, onSubmit: () => Promise<null>) {
  return <ProjectComposer
    busy={false} canRefresh={false} disabled={false}
    designPresetItems={[]} designPresetStatus="ready" editArtifactTargets={[]}
    model="generate" modelCatalog={catalog}
    modelChoices={[{ key: "generate", modelId: "quality", workflow: "generate", label: "生成", description: "生成" }]}
    modelMenuOpen={false} onRefresh={async () => undefined} onRetryDesignPresets={() => undefined}
    onSelectModel={() => undefined} onSubmitPrompt={onSubmit} onTargetSurfaceChange={() => undefined}
    onToggleModel={onToggle} projectDesignSystemChoices={[]} projectId="project-1"
    projectMode="generated" prompt="生成一个项目" runStatus={null} setPrompt={() => undefined} targetSurface="web"
  />;
}

function apiError(status: number) {
  return new WorkbenchApiError({ type: "about:blank", title: `HTTP ${status}`, status, code: `HTTP_${status}`, detail: `HTTP ${status}` });
}

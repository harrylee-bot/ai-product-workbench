// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type {
  ProjectBootstrap,
  StartRunRequest,
} from "@workbench/workbench-contracts";
import { StudioComposer, type StudioComposerProps } from "./composer";
import {
  newComposerEntry,
  type ComposerDraft,
} from "@/lib/studio/composer-session";
const state = vi.hoisted(() => ({
  presets: [] as {
    presetId: string;
    version: number;
    checksum: string;
    label: string;
  }[],
  models: [
    {
      id: "model-one",
      displayName: "模型一",
      supportedWorkflows: ["generate", "edit"],
    },
  ],
}));
vi.mock("@/lib/workbench/features/runtime-models", () => ({
  useWorkbenchRuntimeModels: () => ({ data: { items: state.models } }),
}));
vi.mock("@/lib/workbench/features/design-presets", () => ({
  useWorkbenchDesignPresets: () => ({ data: { items: state.presets } }),
}));
vi.mock("@/lib/workbench/features/import-sources", () => ({
  useWorkbenchImportSources: () => ({ data: { items: [] } }),
}));
const preset = {
  presetId: "calm",
  version: 1,
  checksum: "a".repeat(64),
  label: "简洁",
};
const original = {
  ...newComposerEntry({ kind: "new", key: "new", title: "新建" }, "生成需求")
    .draft,
  modelId: "model-one",
  designStyle: {
    kind: "preset" as const,
    presetId: preset.presetId,
    version: preset.version,
    checksum: preset.checksum,
  },
};
function Harness({
  onSubmit,
  initialInput,
  pinnedDesign,
}: Pick<StudioComposerProps, "onSubmit" | "initialInput" | "pinnedDesign">) {
  const [draft, setDraft] = useState<ComposerDraft>(original);
  return (
    <StudioComposer
      projectId="project-one"
      bootstrap={{ artifacts: [] } as unknown as ProjectBootstrap}
      prompt={draft.prompt}
      setPrompt={(prompt) => setDraft((current) => ({ ...current, prompt }))}
      busy={false}
      disabled={false}
      draft={draft}
      updateDraft={setDraft}
      onSubmit={onSubmit}
      initialInput={initialInput}
      pinnedDesign={pinnedDesign}
    />
  );
}
beforeEach(() => {
  state.presets = [preset];
  state.models = [
    {
      id: "model-one",
      displayName: "模型一",
      supportedWorkflows: ["generate", "edit"],
    },
  ];
});
afterEach(cleanup);
describe("Studio unavailable input protection", () => {
  it("blocks a removed or changed preset until the user explicitly selects a current version", async () => {
    const onSubmit = vi.fn().mockResolvedValue("accepted");
    const { rerender } = render(<Harness onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled();
    state.presets = [{ ...preset, version: 2, checksum: "b".repeat(64) }];
    rerender(<Harness onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "发送需求" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "设计风格" }), {
      target: { value: `preset:calm:2:${"b".repeat(64)}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送需求" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0].designStyle).toEqual({
      kind: "preset",
      presetId: "calm",
      version: 2,
      checksum: "b".repeat(64),
    });
  });
  it("permits an unavailable preset only with the exact frozen input snapshot", () => {
    state.presets = [];
    const initialInput = {
      designStyle: original.designStyle,
      workflow: "generate",
    } as StartRunRequest;
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Harness onSubmit={onSubmit} initialInput={initialInput} />,
    );
    expect(screen.getByRole("button", { name: "发送需求" })).toBeDisabled();
    // Materialized snapshot content is rendered by PlanInputSummary; this test
    // checks that mere presence of a reference is not treated as a snapshot.
    rerender(
      <Harness
        onSubmit={onSubmit}
        initialInput={initialInput}
        pinnedDesign={{
          artifactVersionId: null,
          snapshotSha256: "a".repeat(64),
          snapshot: {
            protocol: "workbench.runtime.design-preset.v1",
          } as NonNullable<StudioComposerProps["pinnedDesign"]>["snapshot"],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled();
  });
  it("retains an unavailable model selection and requires an explicit replacement", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<Harness onSubmit={onSubmit} />);
    state.models = [
      {
        id: "model-two",
        displayName: "模型二",
        supportedWorkflows: ["generate", "edit"],
      },
    ];
    rerender(<Harness onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "发送需求" })).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "所选模型不可用" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
      target: { value: "model-two" },
    });
    expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled();
  });
});

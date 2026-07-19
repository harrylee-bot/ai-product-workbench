// @vitest-environment jsdom

import {
  createDesignSystemRequestSchema,
  type DesignPresetCatalogItem,
} from "@workbench/workbench-contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  automaticDesignStyleSelection,
  CustomDesignSystemDialog,
  HomeDesignSystemMenu,
  ProjectDesignSystemMenu,
} from "./workbench-design-system-controls";

afterEach(cleanup);

describe("Workbench Design System controls", () => {
  it("maps a real Workspace catalog item to an import intent", () => {
    const onSelect = vi.fn();
    render(
      <HomeDesignSystemMenu
        catalogItems={[catalogItem()]}
        fetchingNextPage={false}
        hasNextPage={false}
        onCreateCustom={vi.fn()}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
        onSelect={onSelect}
        selected={automaticDesignStyleSelection}
        status="ready"
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Product UI/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      key: "catalog:version-source",
      provision: expect.objectContaining({
        kind: "import",
        sourceArtifactVersionId: "version-source",
        idempotencyKey: expect.stringMatching(/^design-system-import:/),
      }),
    }));
  });

  it("maps a current Project choice to an artifact design style", () => {
    const onSelect = vi.fn();
    render(
      <ProjectDesignSystemMenu
        onCreateCustom={vi.fn()}
        onRetryPresets={vi.fn()}
        onSelect={onSelect}
        presetItems={[]}
        presetStatus="ready"
        projectChoices={[{
          artifactId: "artifact-ready",
          artifactVersionId: "version-ready",
          label: "Project UI",
          version: 2,
        }]}
        selected={automaticDesignStyleSelection}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Project UI/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      designStyle: { kind: "artifact", artifactVersionId: "version-ready" },
    }));
  });

  it("submits the exact server catalog identity for a Design preset", () => {
    const onSelect = vi.fn();
    const preset = presetItem();
    render(
      <ProjectDesignSystemMenu
        onCreateCustom={vi.fn()}
        onRetryPresets={vi.fn()}
        onSelect={onSelect}
        presetItems={[preset]}
        presetStatus="ready"
        projectChoices={[]}
        selected={automaticDesignStyleSelection}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: preset.label }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      designStyle: {
        kind: "preset",
        presetId: preset.presetId,
        version: preset.version,
        checksum: preset.checksum,
      },
      label: preset.label,
      swatch: preset.swatch,
    }));
  });

  it("fails closed and exposes retry when the preset catalog is unavailable", () => {
    const onRetry = vi.fn();
    render(
      <ProjectDesignSystemMenu
        onCreateCustom={vi.fn()}
        onRetryPresets={onRetry}
        onSelect={vi.fn()}
        presetItems={[presetItem()]}
        presetStatus="error"
        projectChoices={[]}
        selected={automaticDesignStyleSelection}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: "Alexandria" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("builds a valid workbench.design-system.v1 document from the structured form", async () => {
    const onSubmit = vi.fn();
    render(
      <CustomDesignSystemDialog
        busy={false}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        open
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用此设计" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const request = onSubmit.mock.calls[0]?.[0];
    expect(createDesignSystemRequestSchema.parse(request).document).toMatchObject({
      protocol: "workbench.design-system.v1",
      title: "项目设计系统",
    });
  });
});

function catalogItem() {
  return {
    projectId: "project-source",
    projectTitle: "Source Project",
    artifactId: "artifact-source",
    artifactTitle: "Product UI",
    artifactVersionId: "version-source",
    version: 3,
    checksum: "a".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

function presetItem(): DesignPresetCatalogItem {
  return {
    presetId: "workbench.alexandria",
    version: 1,
    checksum: "b".repeat(64),
    label: "Alexandria",
    swatch: "#6f85ff",
    description: "A clear editorial product language with disciplined hierarchy and quiet utility.",
    directives: {
      composition: "Use a disciplined editorial grid with clear work-focused regions.",
      hierarchy: "Prioritize primary tasks with restrained contrast and predictable grouping.",
      typography: "Use legible sans-serif typography with compact operational headings.",
      components: "Keep controls compact, explicit, and consistent across repeated workflows.",
      imagery: "Use inspectable product imagery only when it carries task information.",
      interaction: "Keep feedback immediate and motion restrained around direct manipulation.",
    },
    tokens: {
      colors: {
        canvas: "#111214",
        surface: "#18191b",
        surfaceMuted: "#24262a",
        textPrimary: "#f1f3f4",
        textSecondary: "#aeb3bb",
        accent: "#6f85ff",
        accentContrast: "#ffffff",
        border: "#3a3d43",
        focus: "#8ea0ff",
        danger: "#d96f6f",
      },
      typography: {
        headingFamily: "Inter",
        bodyFamily: "Inter",
        headingWeight: 600,
        bodyWeight: 400,
        baseSizePx: 14,
        lineHeight: 1.5,
      },
      geometry: {
        cornerRadiusPx: 8,
        controlRadiusPx: 8,
        borderWidthPx: 1,
        controlHeightPx: 36,
      },
      layout: {
        density: "balanced",
        spacingUnitPx: 4,
        contentMaxWidthPx: 1280,
        gridColumns: 12,
      },
      motion: {
        durationFastMs: 120,
        durationStandardMs: 220,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  };
}

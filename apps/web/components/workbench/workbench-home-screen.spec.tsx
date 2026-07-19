// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import path from "node:path";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HomeScreen, InspirationStrip } from "./workbench-home-screen";
import { workbenchHomeTemplates } from "./workbench-home-templates";

const transportMocks = vi.hoisted(() => ({
  getCommunicationPreferences: vi.fn(async () => ({
    etag: '"0"',
    value: {
      createdAt: null,
      productUpdatesEmail: false,
      researchInvitations: false,
      revision: 0,
      updatedAt: null,
    },
  })),
  updateCommunicationPreferences: vi.fn(),
}));

vi.mock("@/lib/workbench/features/identity/api-adapter", () => ({
  useWorkbenchIdentityApi: () => transportMocks,
}));

const homeScreenFile = path.join(process.cwd(), "components/workbench/workbench-home-screen.tsx");

afterEach(cleanup);

describe("Workbench home inspiration rotation", () => {
  it("advances once for each external rotation request", async () => {
    const rendered = render(
      <InspirationStrip onSelectTemplate={() => undefined} rotationRequest={0} />,
    );

    expect(firstCardTitle()).toBe(workbenchHomeTemplates[0].title);

    rendered.rerender(
      <InspirationStrip onSelectTemplate={() => undefined} rotationRequest={1} />,
    );
    await expectFirstCardTitle(workbenchHomeTemplates[1].title);

    rendered.rerender(
      <InspirationStrip onSelectTemplate={() => undefined} rotationRequest={1} />,
    );
    expect(firstCardTitle()).toBe(workbenchHomeTemplates[1].title);

    rendered.rerender(
      <InspirationStrip onSelectTemplate={() => undefined} rotationRequest={2} />,
    );
    await expectFirstCardTitle(workbenchHomeTemplates[2].title);
  });

  it("keeps the previous and next controls connected to the same rotation state", async () => {
    render(<InspirationStrip onSelectTemplate={() => undefined} rotationRequest={0} />);

    fireEvent.click(screen.getByRole("button", { name: "下一组灵感" }));
    await expectFirstCardTitle(workbenchHomeTemplates[1].title);

    fireEvent.click(screen.getByRole("button", { name: "上一组灵感" }));
    await expectFirstCardTitle(workbenchHomeTemplates[0].title);
  });

  it("maps every card to a meaningful prompt and supports keyboard selection", async () => {
    const user = userEvent.setup();
    const onSelectTemplate = vi.fn();
    render(
      <InspirationStrip onSelectTemplate={onSelectTemplate} rotationRequest={0} />,
    );

    const templateButtons = screen.getAllByRole("button", { name: /^使用模板：/ });
    expect(templateButtons).toHaveLength(workbenchHomeTemplates.length);
    expect(new Set(workbenchHomeTemplates.map((template) => template.prompt)).size)
      .toBe(workbenchHomeTemplates.length);

    workbenchHomeTemplates.forEach((template, index) => {
      expect(template.prompt.length).toBeGreaterThan(30);
      expect(template.prompt).not.toMatch(/探索卡片|占位|placeholder/i);
      expect(templateButtons[index].getAttribute("aria-label")).toBe(`使用模板：${template.title}`);
    });

    templateButtons[2].focus();
    await user.keyboard("{Enter}");
    expect(onSelectTemplate).toHaveBeenCalledOnce();
    expect(onSelectTemplate).toHaveBeenCalledWith(workbenchHomeTemplates[2]);
  });
});

describe("Workbench home inspiration templates", () => {
  it("fills the existing composer, keeps the prompt editable, and submits through the existing path", async () => {
    const onSubmitPrompt = vi.fn(async () => "project-template");
    render(<HomeScreenHarness onSubmitPrompt={onSubmitPrompt} />);

    fireEvent.click(screen.getByRole("button", {
      name: `使用模板：${workbenchHomeTemplates[2].title}`,
    }));

    const composer = screen.getByRole("textbox", { name: "提示词" });
    expect((composer as HTMLTextAreaElement).value).toBe(workbenchHomeTemplates[2].prompt);
    expect(screen.getByRole("button", { name: "Web" }).getAttribute("aria-pressed")).toBe("true");

    const editedPrompt = `${workbenchHomeTemplates[2].prompt} 首屏增加作品分类筛选。`;
    fireEvent.change(composer, { target: { value: editedPrompt } });
    expect((composer as HTMLTextAreaElement).value).toBe(editedPrompt);

    const submitButton = screen.getByRole("button", { name: "提交提示" });
    await waitFor(() => expect((submitButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submitButton);

    await waitFor(() => expect(onSubmitPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: editedPrompt,
      requestedArtifactKinds: ["prototype"],
      targetSurface: "web",
    })));
  });
});

describe("Workbench home responsive shell", () => {
  it("keeps the project panel mounted as an accessible mobile bottom drawer", async () => {
    render(<HomeScreenHarness onSubmitPrompt={vi.fn(async () => "project")} />);

    const drawer = document.querySelector<HTMLElement>("[data-home-project-drawer-open]");
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute("data-home-project-drawer-open")).toBe("false");
    expect(drawer?.className).toContain("translate-y-full");
    expect(drawer?.className).toContain("duration-300");

    fireEvent.click(screen.getByRole("button", { name: "项目列表" }));
    await waitFor(() => expect(drawer?.getAttribute("data-home-project-drawer-open")).toBe("true"));
    expect(drawer?.className).not.toContain("pointer-events-none");
  });

  it("keeps the parity dimensions in the source contract", async () => {
    const source = await readFile(homeScreenFile, "utf8");
    expect(source).toContain("h-[56px]");
    expect(source).toContain("md:w-[375px]");
    expect(source).toContain("md:rounded-[16px]");
    expect(source).toContain("h-[calc(100vh-80px)]");
    expect(source).toContain("duration-300");
  });
});

describe("产品工作台首页设计来源入口", () => {
  it("opens the real design-system chooser instead of an arbitrary project", async () => {
    const source = await readFile(homeScreenFile, "utf8");
    const entry = source.slice(
      source.indexOf("以您的设计为基础") - 700,
      source.indexOf("以您的设计为基础") + 100,
    );

    expect(entry).toContain("onClick={toggleHomeStyleMenu}");
    expect(entry).not.toContain("projects[0]");
  });
});

function firstCardTitle(): string | null {
  return screen.getAllByRole("heading", { level: 3 })[0]?.textContent ?? null;
}

async function expectFirstCardTitle(title: string): Promise<void> {
  await waitFor(() => expect(firstCardTitle()).toBe(title));
}

function HomeScreenHarness({
  onSubmitPrompt,
}: {
  onSubmitPrompt: ComponentProps<typeof HomeScreen>["onSubmitPrompt"];
}) {
  const [prompt, setPrompt] = useState("");
  const queryClient = useStableQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <HomeScreen
        accountUser={null}
        busy={false}
        designSystemCatalogFetchingNextPage={false}
        designSystemCatalogHasNextPage={false}
        designSystemCatalogItems={[]}
        designSystemCatalogStatus="ready"
        hasNextProjectPage={false}
        homeProjectTab="mine"
        loadError={null}
        loadStatus="ready"
        modelCatalog={{ error: null, retrying: false, status: "ready" }}
        modelChoices={[{
          description: "Generate a product prototype",
          key: "model:quality",
          label: "Quality",
          modelId: "quality",
          workflow: "generate",
        }]}
        onArchiveProject={async () => undefined}
        onDuplicateProject={async () => undefined}
        onLoadMoreDesignSystems={() => undefined}
        onLoadMoreProjects={() => undefined}
        onLogout={async () => undefined}
        onOpenProject={() => undefined}
        onRetryDesignSystems={() => undefined}
        onRetryModels={() => undefined}
        onRetryProjects={() => undefined}
        onSubmitPrompt={onSubmitPrompt}
        projectPageLoading={false}
        projectSearch=""
        projects={[]}
        prompt={prompt}
        setHomeProjectTab={() => undefined}
        setProjectSearch={() => undefined}
        setPrompt={setPrompt}
      />
    </QueryClientProvider>
  );
}

function useStableQueryClient(): QueryClient {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  }));
  return queryClient;
}

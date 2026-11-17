// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectBootstrap } from "@workbench/workbench-contracts";
import { StudioComposer } from "./composer";
import { newComposerEntry } from "@/lib/studio/composer-session";
import { WorkbenchApiError } from "@/lib/workbench/api";

const api = vi.hoisted(() => ({ listImportSources: vi.fn(), getImportSource: vi.fn() }));
vi.mock("@/lib/studio/api", () => ({ useWorkbenchImportSourcesApi: () => api }));
vi.mock("@/lib/workbench/features/runtime-models", () => ({ useWorkbenchRuntimeModels: () => ({ data: { items: [{ id: "deepseek-flash", displayName: "Flash", supportedWorkflows: ["generate"] }] } }) }));
vi.mock("@/lib/workbench/features/design-presets", () => ({ useWorkbenchDesignPresets: () => ({ data: { items: [] } }) }));
const clients: QueryClient[] = [];
const source = (id: string) => ({ id, projectId: "project-one", label: id === "old-source" ? "较早的合法资料" : id, status: "ready", revision: 1 });
const firstPage = Array.from({ length: 30 }, (_, index) => source(`recent-${index}`));
function Harness() {
  const [draft, updateDraft] = useState({ ...newComposerEntry({ kind: "new", key: "new", title: "新建" }, "读取资料后继续讨论").draft, sourceIds: ["old-source"], modelId: "deepseek-flash" });
  return <StudioComposer projectId="project-one" bootstrap={{ artifacts: [] } as unknown as ProjectBootstrap}
    prompt={draft.prompt} setPrompt={prompt => updateDraft(current => ({ ...current, prompt }))}
    draft={draft} updateDraft={updateDraft} disabled={false} busy={false} onSubmit={async () => null} />;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client);
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}
beforeEach(() => {
  api.listImportSources.mockReset().mockImplementation(async (_project, query) => query.cursor
    ? { items: [source("old-source")], nextCursor: null }
    : { items: firstPage, nextCursor: "page-two" });
  api.getImportSource.mockReset().mockImplementation(async id => ({ value: source(id), etag: '"1"' }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("independently verifies a restored source outside the first 30 and exposes real directory pagination", async () => {
  mount();
  await waitFor(() => expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled());
  expect(api.getImportSource).toHaveBeenCalledWith("old-source");
  expect(screen.getByRole("button", { name: "移除引用 较早的合法资料" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "资料 1" }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(30);
  fireEvent.click(screen.getByRole("button", { name: "加载更多资料" }));
  await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(31));
  expect(api.listImportSources).toHaveBeenLastCalledWith("project-one", { cursor: "page-two", limit: 30 });
  expect(screen.getByRole("checkbox", { name: /较早的合法资料/ })).toBeChecked();
});

it("distinguishes an unavailable network from an authoritative missing source and preserves the reference", async () => {
  api.getImportSource.mockRejectedValue(new Error("offline"));
  mount();
  await screen.findByText("暂时无法核验引用资料，请重试。引用与文字已保留。");
  expect(screen.getByRole("button", { name: "发送需求" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移除引用 old-source" })).toBeInTheDocument();
  api.getImportSource.mockResolvedValue({ value: source("old-source"), etag: '"1"' });
  fireEvent.click(screen.getByRole("button", { name: "重新核验引用资料" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "发送需求" })).toBeEnabled());
});

it.each([403, 404])("blocks an actually rejected source (%s) without silently dropping it", async status => {
  api.getImportSource.mockRejectedValue(new WorkbenchApiError({ status, code: "SOURCE_UNAVAILABLE", title: "source unavailable", type: "about:blank" }));
  mount();
  await screen.findByText("引用资料尚未就绪、已删除或无权限。请移除失效引用或重新加载资料。");
  expect(screen.getByRole("button", { name: "发送需求" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "移除引用 old-source" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "描述需求或修改" })).toHaveValue("读取资料后继续讨论");
});

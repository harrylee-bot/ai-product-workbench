// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import { VariantSources } from "./relations";

const api = vi.hoisted(() => ({
  getRevision: vi.fn(),
  getArtifactVersionRelations: vi.fn(),
}));
vi.mock("@/lib/studio/api", () => ({
  useWorkbenchArtifactsApi: () => api,
  useWorkbenchPrototypeV2Api: () => api,
  useWorkbenchRunsApi: () => ({}),
}));
const revisionKey = [
  ...workbenchQueryKeys.prototypeV2("project-one"),
  "revision",
  "revision-one",
];
const clients: QueryClient[] = [];
function show(cached?: object) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  if (cached) client.setQueryData(revisionKey, { value: cached });
  render(
    <QueryClientProvider client={client}>
      <VariantSources
        projectId="project-one"
        intent="followup-design"
        targets={[
          {
            artifactId: "artifact-one",
            artifactVersionId: "version-one",
            screenIds: ["page-one"],
          },
        ]}
      />
    </QueryClientProvider>,
  );
  return client;
}
const cachedRevision = {
  id: "revision-one",
  projectId: "project-one",
  planId: "plan-one",
  pages: [{ id: "page-one", title: "活动详情" }],
  // A source-name summary must not initiate this potentially multi-MB read.
  previewHtml: "x".repeat(8_300_000),
};
beforeEach(() => {
  vi.clearAllMocks();
  api.getRevision.mockResolvedValue({ value: cachedRevision });
  api.getArtifactVersionRelations.mockResolvedValue({
    version: {
      artifactId: "artifact-one",
      artifactVersionId: "version-one",
      version: 1,
      title: "固定原型",
      prototypeRevision: { id: "revision-one", planId: "plan-one", version: 1 },
    },
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

it("reads the canonical workspace cache and initiates no HTML request for source names", async () => {
  show(cachedRevision);
  expect(await screen.findByText("· 活动详情")).toBeVisible();
  expect(api.getRevision).not.toHaveBeenCalled();
});
it("keeps source page links without automatically downloading a cold revision", async () => {
  const client = show();
  const link = await screen.findByRole("link", { name: "页面 page-one" });
  expect(link).toHaveAttribute(
    "href",
    "/studio/project-one?view=pages&plan=plan-one&revision=revision-one&page=page-one",
  );
  expect(api.getRevision).not.toHaveBeenCalled();
  // Opening the source elsewhere updates this summary through the same cache.
  act(() => {
    client.setQueryData(revisionKey, { value: cachedRevision });
  });
  expect(await screen.findByText("· 活动详情")).toBeVisible();
  expect(api.getRevision).not.toHaveBeenCalled();
});
it("loads names only on explicit request, using the workspace revision cache", async () => {
  const client = show();
  const load = await screen.findByRole("button", { name: "显示来源页面名称" });
  expect(api.getRevision).not.toHaveBeenCalled();
  fireEvent.click(load);
  expect(await screen.findByText("· 活动详情")).toBeVisible();
  expect(api.getRevision).toHaveBeenCalledExactlyOnceWith("project-one", "revision-one");
  expect(client.getQueryData(revisionKey)).toEqual({ value: cachedRevision });
});
it.each([
  { projectId: "another-project" },
  { id: "another-revision" },
  { planId: "another-plan" },
])("ignores a mismatched cached revision: %j", async (mismatch) => {
  show({ ...cachedRevision, ...mismatch });
  await screen.findByRole("link", { name: "页面 page-one" });
  expect(screen.queryByText("· 活动详情")).not.toBeInTheDocument();
  expect(api.getRevision).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchProjectsApi } from "./index";

const timestamp = "2026-07-12T00:00:00.000Z";

const project = {
  id: "project-1",
  workspaceId: "workspace-1",
  title: "产品工作台",
  summary: null,
  status: "active" as const,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const thread = {
  id: "thread-1",
  projectId: project.id,
  title: "Main thread",
  status: "active" as const,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

const run = {
  id: "run-1",
  requestId: "request-1",
  projectId: project.id,
  threadId: thread.id,
  retryOfRunId: null,
  status: "queued" as const,
  modelId: "model-1",
  workflow: "edit" as const,
  generationIntent: null,
  targetSurface: "app" as const,
  designStyle: { kind: "automatic" as const },
  artifactTargets: [
    {
      artifactId: "artifact-2",
      artifactVersionId: "version-2",
      screenIds: ["screen-2"],
    },
    {
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      screenIds: [],
    },
  ],
  requestedArtifactKinds: ["document" as const],
  sources: [],
  knowledgeReleaseId: null,
  phase: null,
  phaseLabel: null,
  progress: null,
  attempt: 0,
  lastEventSequence: 0,
  cancelRequestedAt: null,
  failure: null,
  cancellationReason: null,
  createdAt: timestamp,
  startedAt: null,
  finishedAt: null,
};

const bootstrap = {
  project,
  access: { role: "owner" as const },
  threads: [thread],
  selectedThreadId: thread.id,
  entries: [],
  board: {
    id: "board-1",
    projectId: project.id,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  },
  artifacts: [],
  latestRun: run,
};

const member = {
  projectId: project.id,
  principalId: "principal-2",
  role: "editor" as const,
  displayName: "Editor",
  email: "editor@example.com",
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("Projects API contracts", () => {
  it("loads the Bootstrap projection for the explicitly selected Thread", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/api/v1/projects/project-1/bootstrap");
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      return Response.json(bootstrap, { headers: { ETag: '"1"' } });
    });
    const api = projectsApi(fetch);

    await expect(api.getProjectBootstrap("project-1", "thread-1"))
      .resolves.toEqual({ value: bootstrap, etag: '"1"' });
  });

  it("owns all core Project and membership routes through the typed client", async () => {
    const listItem = { ...project, role: "owner" as const, relationship: "owned" as const };
    const createdProject = { ...project, id: "project-2", title: "New project" };
    const updatedProject = { ...project, title: "Renamed project", revision: 2 };
    const duplicate = {
      sourceProjectId: project.id,
      project: { ...project, id: "project-3", title: "产品工作台 copy" },
      createdAt: "2026-07-12T00:01:00.000Z",
    };
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);

      if (url.pathname === "/api/v1/projects") {
        expect(request.method).toBe("GET");
        expect(url.searchParams.get("q")).toBe("workbench");
        expect(url.searchParams.get("relationship")).toBe("owned");
        expect(url.searchParams.get("cursor")).toBe("cursor-1");
        expect(url.searchParams.get("limit")).toBe("25");
        return Response.json({ items: [listItem], nextCursor: "cursor-2" });
      }

      if (url.pathname === "/api/v1/workspaces/workspace-1/projects") {
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({ title: "New project" });
        return Response.json(createdProject, {
          status: 201,
          headers: { ETag: '"1"' },
        });
      }

      if (url.pathname.endsWith("/projects/project-1/duplicate")) {
        expect(request.method).toBe("POST");
        expect(request.headers.get("idempotency-key")).toBe("duplicate:request_123");
        expect(await request.json()).toEqual({ title: "产品工作台 copy" });
        return Response.json(duplicate, {
          status: 201,
          headers: { ETag: '"0"' },
        });
      }

      if (url.pathname.endsWith("/projects/project-1/members/principal-2")) {
        expect(request.headers.get("if-match")).toBe('"2"');
        if (request.method === "PUT") {
          expect(await request.json()).toEqual({ role: "editor" });
          return Response.json(member, { headers: { ETag: '"3"' } });
        }
        expect(request.method).toBe("DELETE");
        return new Response(null, { status: 204, headers: { ETag: '"4"' } });
      }

      if (url.pathname.endsWith("/projects/project-1/members")) {
        expect(request.method).toBe("GET");
        return Response.json({ items: [member] });
      }

      if (url.pathname.endsWith("/projects/project-1")) {
        expect(request.headers.get("if-match")).toBe('"1"');
        if (request.method === "PATCH") {
          expect(await request.json()).toEqual({ title: "Renamed project" });
          return Response.json(updatedProject, { headers: { ETag: '"2"' } });
        }
        expect(request.method).toBe("DELETE");
        return Response.json({ ...project, status: "archived", revision: 2 }, {
          headers: { ETag: '"2"' },
        });
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const api = projectsApi(fetch);

    await expect(api.listProjects({
      q: "workbench",
      relationship: "owned",
      cursor: "cursor-1",
      limit: 25,
    })).resolves.toEqual({ items: [listItem], nextCursor: "cursor-2" });
    await expect(api.createProject("workspace-1", { title: "New project" }))
      .resolves.toEqual({ value: createdProject, etag: '"1"' });
    await expect(api.updateProject(
      "project-1",
      { title: "Renamed project" },
      '"1"',
    )).resolves.toEqual({ value: updatedProject, etag: '"2"' });
    await expect(api.duplicateProject(
      "project-1",
      { title: "产品工作台 copy" },
      "duplicate:request_123",
    )).resolves.toEqual({ value: duplicate, etag: '"0"' });
    await expect(api.archiveProject("project-1", '"1"')).resolves.toMatchObject({
      value: { status: "archived", revision: 2 },
      etag: '"2"',
    });
    await expect(api.listProjectMembers("project-1"))
      .resolves.toEqual({ items: [member] });
    await expect(api.setProjectMemberRole(
      "project-1",
      "principal-2",
      { role: "editor" },
      '"2"',
    )).resolves.toEqual({ value: member, etag: '"3"' });
    await expect(api.removeProjectMember("project-1", "principal-2", '"2"'))
      .resolves.toEqual({ etag: '"4"' });
  });
});

function projectsApi(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchProjectsApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}

import type {
  ExportJob,
  ProjectPreview,
} from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkbenchApiClient } from "../../../api/client";
import { WorkbenchContractError } from "../../../transport/contracts";
import { WorkbenchExportsApi } from "./index";

const timestamp = "2026-07-13T00:00:00.000Z";
const releaseId = "release-1";
const exportJob: ExportJob = {
  id: "export-1",
  releaseId,
  createdById: "principal-1",
  format: "html",
  packaging: "single_file",
  selection: { kind: "release" },
  status: "queued",
  revision: 1,
  options: { nested: { enabled: true } },
  output: null,
  failure: null,
  createdAt: timestamp,
  startedAt: null,
  finishedAt: null,
  updatedAt: timestamp,
};
const projectPreview: ProjectPreview = {
  id: "preview-1",
  projectId: "project-1",
  boardId: "board-1",
  boardRevision: 3,
  selection: { kind: "release" },
  status: "queued",
  revision: 0,
  failure: null,
  createdAt: timestamp,
  expiresAt: "2026-07-14T00:00:00.000Z",
  updatedAt: timestamp,
};
const previewToken = {
  url: "https://preview.example/preview/capability",
  expiresAt: "2026-07-13T01:00:00.000Z",
};

describe("Exports API contracts", () => {
  it("owns Export capabilities, jobs, cancellation, preview tokens, and Blob content", async () => {
    const outputSha256 = "d".repeat(64);
    const bytes = new Uint8Array([60, 104, 49, 62]);
    const cancelled = { ...exportJob, status: "cancelled" as const, revision: 2, finishedAt: timestamp };
    const requests: Request[] = [];
    const api = createApi(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/exports/capabilities")) {
        return Response.json(capabilities());
      }
      if (url.pathname.endsWith("/projects/project-1/exports") && request.method === "GET") {
        expect(url.searchParams.get("cursor")).toBe("cursor-1");
        expect(url.searchParams.get("limit")).toBe("25");
        return Response.json({ items: [exportJob], nextCursor: null });
      }
      if (url.pathname.endsWith("/projects/project-1/exports")) {
        return Response.json(exportJob, { status: 202, headers: { ETag: '"1"' } });
      }
      if (url.pathname.endsWith("/cancel")) {
        return Response.json(cancelled, { headers: { ETag: '"2"' } });
      }
      if (url.pathname.endsWith("/preview-token")) {
        return Response.json(previewToken);
      }
      if (url.pathname.endsWith("/content")) {
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new Response(bytes, {
          headers: { ETag: `"${outputSha256}"`, "Content-Type": "text/html" },
        });
      }
      return Response.json(exportJob, { headers: { ETag: '"1"' } });
    });
    const request = {
      releaseId,
      format: "html" as const,
      packaging: "single_file" as const,
      selection: { kind: "release" as const },
      options: { nested: { enabled: true } },
    };

    await expect(api.getExportCapabilities()).resolves.toEqual(capabilities());
    await expect(api.listExportJobs("project-1", { cursor: "cursor-1", limit: 25 }))
      .resolves.toEqual({ items: [exportJob], nextCursor: null });
    await expect(api.createExportJob("project-1", request, "export:req_123"))
      .resolves.toEqual({ value: exportJob, etag: '"1"' });
    await expect(api.getExportJob(exportJob.id))
      .resolves.toEqual({ value: exportJob, etag: '"1"' });
    await expect(api.cancelExportJob(exportJob.id, '  "1"  '))
      .resolves.toEqual({ value: cancelled, etag: '"2"' });
    await expect(api.createExportPreviewToken(exportJob.id)).resolves.toEqual(previewToken);
    const content = await api.getExportContent(exportJob.id);
    expect(content.etag).toBe(`"${outputSha256}"`);
    expect(new Uint8Array(await content.value.arrayBuffer())).toEqual(bytes);

    const create = requests.find((item) => (
      item.method === "POST" && item.url.endsWith("/projects/project-1/exports")
    ));
    const cancel = requests.find((item) => item.url.endsWith("/cancel"));
    expect(create?.headers.get("idempotency-key")).toBe("export:req_123");
    await expect(create?.clone().json()).resolves.toEqual(request);
    expect(cancel?.headers.get("if-match")).toBe('"1"');
  });

  it("owns Project Preview creation, polling reads, and capability tokens", async () => {
    const requests: Request[] = [];
    const api = createApi(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/projects/project-1/previews")) {
        return Response.json(projectPreview, { status: 202 });
      }
      if (url.pathname.endsWith("/previews/preview-1/token")) {
        return Response.json(previewToken);
      }
      if (url.pathname.endsWith("/previews/preview-1")) {
        return Response.json(projectPreview);
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    const request = {
      boardId: projectPreview.boardId,
      boardRevision: projectPreview.boardRevision,
      selection: projectPreview.selection,
    };

    await expect(api.createProjectPreview("project-1", request, "preview:req_123"))
      .resolves.toEqual(projectPreview);
    await expect(api.getProjectPreview(projectPreview.id)).resolves.toEqual(projectPreview);
    await expect(api.createProjectPreviewToken(projectPreview.id)).resolves.toEqual(previewToken);

    const create = requests.find((item) => item.url.endsWith("/projects/project-1/previews"));
    expect(create?.headers.get("idempotency-key")).toBe("preview:req_123");
    await expect(create?.clone().json()).resolves.toEqual(request);
  });

  it("rejects undisclosed capability fields, spoofed Blob bodies, and missing ETags", async () => {
    const invalidCapabilities = {
      ...capabilities(),
      formats: {
        ...capabilities().formats,
        figma: { available: true, authentication: "not_required", reasonCode: null, internalProof: "not-public" },
      },
    };
    const capabilityApi = createApi(async () => Response.json(invalidCapabilities));
    const spoofedBlob = {
      arrayBuffer: async () => new ArrayBuffer(0),
      size: 0,
      slice: () => spoofedBlob,
      stream: () => new ReadableStream(),
      text: async () => "",
      type: "application/octet-stream",
      [Symbol.toStringTag]: "Blob",
    };
    const spoofedResponse = new Response(null, { headers: { ETag: '"spoofed"' } });
    Object.defineProperty(spoofedResponse, "blob", {
      value: vi.fn(async () => spoofedBlob),
    });
    const spoofedContentApi = createApi(async () => spoofedResponse);
    const contentApi = createApi(async () => new Response(new Uint8Array([1])));

    await expect(capabilityApi.getExportCapabilities()).rejects
      .toBeInstanceOf(WorkbenchContractError);
    await expect(spoofedContentApi.getExportContent(exportJob.id)).rejects
      .toBeInstanceOf(WorkbenchContractError);
    await expect(contentApi.getExportContent(exportJob.id)).rejects
      .toBeInstanceOf(WorkbenchContractError);
  });
});

function capabilities() {
  const available = { available: true, authentication: "not_required", reasonCode: null } as const;
  const authRequired = {
    available: false,
    authentication: "required",
    reasonCode: "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED",
  } as const;
  return {
    formats: {
      html: available,
      react: available,
      figma: { available: false, authentication: "not_required", reasonCode: "EXPORT_FIGMA_UNAVAILABLE" } as const,
      mcp: available,
    },
    packaging: { single_file: available, zip: available },
    external: {
      ai_studio: { available: false, authentication: "not_required", reasonCode: "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE" } as const,
      netlify: authRequired,
      lovable: authRequired,
      bolt: authRequired,
    },
  };
}

function createApi(fetch: (request: Request) => Promise<Response>) {
  return new WorkbenchExportsApi(createWorkbenchApiClient({
    baseUrl: "http://workbench.test/api/v1",
    fetch: vi.fn(fetch),
  }));
}

import { createHash } from "node:crypto";
import { boardNodeProtocol, canonicalJson } from "@workbench/workbench-contracts";
import { TerminalExportError } from "@workbench/workbench-export-core";
import { describe, expect, it, vi } from "vitest";
import { ExportProcessor } from "../src/export/export.processor.js";
import { exportRequest } from "../../../packages/workbench-export-core/test/fixtures.js";

function source() {
  const content = { protocol: "example.data.v1", rows: [{ value: 1 }] };
  const checksum = createHash("sha256").update(canonicalJson(content)).digest("hex");
  return {
    releaseId: "release-1",
    projectId: "project-1",
    releaseVersion: 1,
    boardSnapshot: {
      id: "board-1",
      projectId: "project-1",
      revision: 1,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{
        id: "node-1",
        kind: "artifact",
        parentNodeId: null,
        order: 0,
        position: { x: 0, y: 0 },
        size: null,
        artifactId: "artifact-1",
        artifactVersionId: "version-1",
        data: {
          protocol: boardNodeProtocol,
          nodeType: "artifact",
          title: "Metrics",
          artifactKind: "data",
        },
      }],
      edges: [],
    },
    manifest: {
      protocol: "workbench.project-release.v1",
      projectId: "project-1",
      releaseVersion: 1,
      board: { id: "board-1", revision: 1, checksum: "b".repeat(64) },
      artifacts: [{ position: 0, artifactId: "artifact-1", artifactVersionId: "version-1", title: "Metrics", kind: "data", version: 1, schemaVersion: 1, checksum, assets: [] }],
    },
    artifacts: [{
      position: 0,
      artifactId: "artifact-1",
      artifactVersionId: "version-1",
      kind: "data" as const,
      title: "Metrics",
      version: 1,
      schemaVersion: 1,
      checksum,
      content,
      contentMediaType: "application/json",
      assets: [],
    }],
  };
}

function command() {
  return {
    id: "export-1",
    format: "html" as const,
    packaging: "single_file" as const,
    selection: { kind: "release" as const },
    options: {},
    purpose: "export" as const,
    preview: null,
    release: {} as never,
  };
}

function harness() {
  const store = {
    start: vi.fn(async () => ({ kind: "run" as const, command: command() })),
    status: vi.fn(async () => "running"),
    reserveOutput: vi.fn(async (identity) => ({ ...identity, blobId: "blob-1", generation: 1, canonicalStorageKey: "blobs/aa/output/g1" })),
    publishSucceeded: vi.fn(async () => "succeeded" as const),
    fail: vi.fn(async () => undefined),
  };
  const loader = { load: vi.fn(async () => source()) };
  const storage = { putVerified: vi.fn(async () => undefined) };
  const browser = {
    validateHtml: vi.fn(async () => undefined),
  };
  const processor = new ExportProcessor(store as never, loader as never, storage as never, browser as never, { maximumOutputBytes: 10 * 1024 * 1024 });
  return { store, loader, storage, browser, processor };
}

describe("ExportProcessor", () => {
  it("builds, browser-validates, writes and atomically publishes a real HTML output", async () => {
    const test = harness();
    const result = await test.processor.process("export-1", undefined, { retryCount: 0, retryLimit: 5 });
    expect(result).toMatchObject({ kind: "published", status: "succeeded", blobId: "blob-1" });
    expect(test.browser.validateHtml).toHaveBeenCalledOnce();
    expect(test.storage.putVerified).toHaveBeenCalledOnce();
    const [identity, bytes] = test.storage.putVerified.mock.calls[0]!;
    expect(identity.mediaType).toBe("text/html; charset=utf-8");
    expect(identity.byteSize).toBe(bytes.byteLength);
    expect(identity.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(new TextDecoder().decode(bytes)).toContain('data-wb-presentation="standalone"');
    expect(test.store.publishSucceeded).toHaveBeenCalledWith("export-1", expect.objectContaining({ blobId: "blob-1" }));
  });

  it("builds the versioned Figma importer package without a browser or clipboard converter", async () => {
    const test = harness();
    const fixture = exportRequest("figma");
    test.store.start.mockResolvedValueOnce({
      kind: "run",
      command: { ...command(), format: "figma", packaging: "zip" },
    } as never);
    test.loader.load.mockResolvedValueOnce(fixture.source as never);

    const result = await test.processor.process("export-1", undefined, { retryCount: 0, retryLimit: 5 });

    expect(result).toMatchObject({ kind: "published", status: "succeeded", blobId: "blob-1" });
    expect(test.browser.validateHtml).not.toHaveBeenCalled();
    const [identity, bytes] = test.storage.putVerified.mock.calls[0]!;
    expect(identity.mediaType).toBe("application/zip");
    expect(Buffer.from(bytes).subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it("passes the persisted Preview initial screen into the build without changing Export selection", async () => {
    const test = harness();
    const fixture = exportRequest();
    test.store.start.mockResolvedValueOnce({
      kind: "run",
      command: {
        ...command(),
        purpose: "preview",
        release: null,
        preview: { initialScreenId: "screen-success" },
        selection: {
          kind: "artifact",
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
        },
      },
    } as never);
    test.loader.load.mockResolvedValueOnce(fixture.source as never);

    await test.processor.process("export-1", undefined, { retryCount: 0, retryLimit: 5 });

    expect(test.browser.validateHtml).toHaveBeenCalledOnce();
    const document = new TextDecoder().decode(test.browser.validateHtml.mock.calls[0]![0]);
    expect(document).toContain('"initialScreenId":"screen-success"');
    expect(document).toContain('data-wb-presentation="preview"');
  });

  it("uses the fitted Preview presentation even without an explicit initial screen", async () => {
    const test = harness();
    const fixture = exportRequest();
    test.store.start.mockResolvedValueOnce({
      kind: "run",
      command: {
        ...command(),
        purpose: "preview",
        release: null,
        preview: { initialScreenId: null },
        selection: {
          kind: "artifact",
          artifactId: "artifact-1",
          artifactVersionId: "version-1",
        },
      },
    } as never);
    test.loader.load.mockResolvedValueOnce(fixture.source as never);

    await test.processor.process("export-1", undefined, { retryCount: 0, retryLimit: 5 });

    const document = new TextDecoder().decode(test.browser.validateHtml.mock.calls[0]![0]);
    expect(document).toContain('data-wb-presentation="preview"');
    expect(document).not.toContain('"initialScreenId":null');
  });

  it("does no work when replay observes a terminal job", async () => {
    const test = harness();
    test.store.start.mockResolvedValueOnce({ kind: "terminal", status: "succeeded" } as never);
    await expect(test.processor.process("export-1")).resolves.toEqual({ kind: "terminal", status: "succeeded" });
    expect(test.loader.load).not.toHaveBeenCalled();
    expect(test.storage.putVerified).not.toHaveBeenCalled();
  });

  it("persists explicit terminal failures and only exhausts retryable failures at the retry limit", async () => {
    const terminal = harness();
    terminal.loader.load.mockRejectedValueOnce(new TerminalExportError("EXPORT_RELEASE_NOT_READY", "Release not ready"));
    await expect(terminal.processor.process("export-1", undefined, { retryCount: 0, retryLimit: 5 })).resolves.toEqual({ kind: "failed", code: "EXPORT_RELEASE_NOT_READY" });
    expect(terminal.store.fail).toHaveBeenCalledWith("export-1", "EXPORT_RELEASE_NOT_READY", "Release not ready");

    const retrying = harness();
    retrying.loader.load.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(retrying.processor.process("export-1", undefined, { retryCount: 1, retryLimit: 5 })).rejects.toThrow("S3 unavailable");
    expect(retrying.store.fail).not.toHaveBeenCalled();

    const exhausted = harness();
    exhausted.loader.load.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(exhausted.processor.process("export-1", undefined, { retryCount: 5, retryLimit: 5 })).resolves.toEqual({ kind: "failed", code: "EXPORT_RETRY_EXHAUSTED" });
    expect(exhausted.store.fail).toHaveBeenCalledWith("export-1", "EXPORT_RETRY_EXHAUSTED", "S3 unavailable");
  });
});

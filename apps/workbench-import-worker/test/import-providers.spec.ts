import { describe, expect, it, vi } from "vitest";
import { TerminalImportError } from "../src/errors.js";
import { FigmaImportProvider } from "../src/import/figma.provider.js";
import { GithubImportProvider } from "../src/import/github.provider.js";
import { maximumImportSourceManifestBlobs } from "../src/import/source-types.js";
import { UrlImportProvider } from "../src/import/url.provider.js";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const providerOptions = {
  maximumBytes: 1_024 * 1_024,
  maximumFiles: maximumImportSourceManifestBlobs,
  timeoutMs: 10_000,
  maximumRedirects: 3,
};

describe("GithubImportProvider", () => {
  it("resolves a mutable ref once and downloads every file through the pinned commit SHA", async () => {
    const client = clientWith([
      json({ sha: commitSha, commit: { tree: { sha: treeSha } } }),
      json({ tree: [
        { type: "blob", path: "src/app.ts", sha: "c".repeat(40) },
        { type: "blob", path: "README.md", sha: "d".repeat(40) },
      ] }),
      response("# Product", "text/markdown"),
      response("export const app = true", "text/plain"),
    ]);
    const provider = new GithubImportProvider(client as never, { ...providerOptions, token: "github-secret" });

    await expect(provider.freeze({
      kind: "github_snapshot",
      repository: "acme/product",
      ref: "main",
    })).resolves.toMatchObject({
      descriptor: { kind: "github_snapshot", repository: "acme/product", commitSha },
      blobs: [
        { path: "README.md", mediaType: "text/markdown" },
        { path: "src/app.ts", mediaType: "text/plain" },
      ],
    });

    expect(client.get.mock.calls[0]![0]).toBe("https://api.github.com/repos/acme/product/commits/main");
    expect(client.get.mock.calls[1]![0]).toContain(`/git/trees/${treeSha}?recursive=1`);
    expect(client.get.mock.calls.slice(2).map(([url]) => url)).toEqual([
      `https://raw.githubusercontent.com/acme/product/${commitSha}/README.md`,
      `https://raw.githubusercontent.com/acme/product/${commitSha}/src/app.ts`,
    ]);
    expect(client.get.mock.calls.slice(2).every(([url]) => !String(url).includes("/main/"))).toBe(true);
    expect(client.get.mock.calls[0]![1]).toMatchObject({
      allowedHosts: ["api.github.com"],
      allowedMediaTypes: [/^application\/json$/u],
      headers: { authorization: "Bearer github-secret" },
    });
  });

  it("uses the manifest limit of 50 and fails before downloading an oversized tree", async () => {
    const tree = Array.from({ length: maximumImportSourceManifestBlobs + 1 }, (_, index) => ({
      type: "blob",
      path: `src/file-${index}.ts`,
      sha: String(index).padStart(40, "0"),
    }));
    const client = clientWith([
      json({ sha: commitSha, commit: { tree: { sha: treeSha } } }),
      json({ tree }),
    ]);
    const provider = new GithubImportProvider(client as never, providerOptions);

    await expect(provider.freeze({ kind: "github_snapshot", repository: "acme/product", ref: "main" }))
      .rejects.toMatchObject({ code: "GITHUB_FILE_LIMIT" });
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("rejects truncated trees and invalid commit identities", async () => {
    const invalidCommit = clientWith([json({ sha: "main", commit: { tree: { sha: treeSha } } })]);
    await expect(new GithubImportProvider(invalidCommit as never, providerOptions).freeze({
      kind: "github_snapshot",
      repository: "acme/product",
      ref: "main",
    })).rejects.toMatchObject({ code: "GITHUB_COMMIT_INVALID" });

    const truncated = clientWith([
      json({ sha: commitSha, commit: { tree: { sha: treeSha } } }),
      json({ truncated: true, tree: [] }),
    ]);
    await expect(new GithubImportProvider(truncated as never, providerOptions).freeze({
      kind: "github_snapshot",
      repository: "acme/product",
      ref: "main",
    })).rejects.toMatchObject({ code: "GITHUB_TREE_TRUNCATED" });
  });

  it("enforces the aggregate repository byte limit", async () => {
    const client = clientWith([
      json({ sha: commitSha, commit: { tree: { sha: treeSha } } }),
      json({ tree: [
        { type: "blob", path: "a.txt", sha: "c".repeat(40) },
        { type: "blob", path: "b.txt", sha: "d".repeat(40) },
      ] }),
      response("abc", "text/plain"),
      response("def", "text/plain"),
    ]);
    const provider = new GithubImportProvider(client as never, { ...providerOptions, maximumBytes: 5 });

    await expect(provider.freeze({ kind: "github_snapshot", repository: "acme/product", ref: "main" }))
      .rejects.toMatchObject({ code: "GITHUB_SIZE_LIMIT" });
  });
});

describe("FigmaImportProvider", () => {
  it("fails before any network access when the worker has no Figma token", async () => {
    const client = clientWith([]);
    const provider = new FigmaImportProvider(client as never, figmaOptions());

    await expect(provider.freeze({ kind: "figma_snapshot", fileKey: "file-key" }))
      .rejects.toMatchObject({ code: "FIGMA_AUTH_REQUIRED" });
    expect(client.get).not.toHaveBeenCalled();
  });

  it("pins the latest returned version and freezes one canonical JSON document", async () => {
    const client = clientWith([
      json({ versions: [{ id: "version-42" }, { id: "version-41" }] }),
      json({ name: "Dashboard", document: { id: "0:0", type: "DOCUMENT" } }),
    ]);
    const provider = new FigmaImportProvider(client as never, figmaOptions("figma-secret"));

    const frozen = await provider.freeze({ kind: "figma_snapshot", fileKey: "file-key" });

    expect(frozen).toMatchObject({
      descriptor: { kind: "figma_snapshot", fileKey: "file-key", versionId: "version-42" },
      blobs: [{ path: "figma.json", mediaType: "application/json" }],
    });
    expect(client.get.mock.calls.map(([url]) => url)).toEqual([
      "https://api.figma.com/v1/files/file-key/versions",
      "https://api.figma.com/v1/files/file-key?version=version-42",
    ]);
    expect(client.get.mock.calls.every(([, options]) => options.headers["x-figma-token"] === "figma-secret"))
      .toBe(true);
    expect(client.get.mock.calls.every(([, options]) => options.allowedHosts[0] === "api.figma.com"))
      .toBe(true);
  });

  it("uses a caller-selected version without consulting the mutable versions list", async () => {
    const client = clientWith([json({ name: "Pinned" })]);
    const provider = new FigmaImportProvider(client as never, figmaOptions("figma-secret"));

    await expect(provider.freeze({
      kind: "figma_snapshot",
      fileKey: "file-key",
      versionId: "version-explicit",
    })).resolves.toMatchObject({
      descriptor: { versionId: "version-explicit" },
    });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get.mock.calls[0]![0]).toContain("?version=version-explicit");
  });

  it("rejects missing versions and malformed file snapshots", async () => {
    const missing = clientWith([json({ versions: [] })]);
    await expect(new FigmaImportProvider(missing as never, figmaOptions("token")).freeze({
      kind: "figma_snapshot",
      fileKey: "file-key",
    })).rejects.toMatchObject({ code: "FIGMA_VERSION_MISSING" });

    const malformed = clientWith([response("not-json", "application/json")]);
    await expect(new FigmaImportProvider(malformed as never, figmaOptions("token")).freeze({
      kind: "figma_snapshot",
      fileKey: "file-key",
      versionId: "version-1",
    })).rejects.toMatchObject({ code: "FIGMA_RESPONSE_INVALID" });
  });

  it("propagates the stable remote authentication failure", async () => {
    const client = { get: vi.fn().mockRejectedValue(new TerminalImportError("IMPORT_REMOTE_AUTH_REQUIRED", "The remote source requires authentication")) };
    await expect(new FigmaImportProvider(client as never, figmaOptions("expired-token")).freeze({
      kind: "figma_snapshot",
      fileKey: "file-key",
      versionId: "version-1",
    })).rejects.toMatchObject({ code: "IMPORT_REMOTE_AUTH_REQUIRED" });
  });
});

describe("UrlImportProvider", () => {
  it("records the final redirect target in the frozen descriptor", async () => {
    const client = clientWith([{
      ...response("<html>ready</html>", "text/html"),
      url: "https://docs.example.test/final",
    }]);
    const provider = new UrlImportProvider(client as never, {
      maximumBytes: 1_024,
      timeoutMs: 10_000,
      maximumRedirects: 3,
    });

    await expect(provider.freeze({ kind: "url_snapshot", sourceUrl: "https://docs.example.test/start" }))
      .resolves.toMatchObject({
        label: "docs.example.test",
        descriptor: {
          kind: "url_snapshot",
          sourceUrl: "https://docs.example.test/start",
          resolvedUrl: "https://docs.example.test/final",
        },
      });
  });
});

function figmaOptions(token?: string) {
  return {
    token,
    maximumBytes: 1_024 * 1_024,
    timeoutMs: 10_000,
    maximumRedirects: 3,
  };
}

function clientWith(results: Array<ReturnType<typeof response>>) {
  const get = vi.fn();
  for (const result of results) get.mockResolvedValueOnce(result);
  return { get };
}

function response(body: string | Buffer, mediaType: string | null = "application/json") {
  return {
    url: "https://remote.test/frozen",
    status: 200,
    mediaType,
    headers: {},
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  };
}

function json(value: unknown) {
  return response(JSON.stringify(value));
}

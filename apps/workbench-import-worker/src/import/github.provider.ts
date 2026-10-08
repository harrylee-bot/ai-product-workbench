import type { CreateImportSourceRequest } from "@workbench/workbench-contracts";
import { TerminalImportError } from "../errors.js";
import { SafeHttpClient } from "../fetch/safe-http-client.js";
import { freezeImport, maximumImportSourceManifestBlobs, type FrozenImport, type ImportProvider } from "./source-types.js";

type GithubProviderOptions = {
  maximumBytes: number;
  maximumFiles: number;
  timeoutMs: number;
  maximumRedirects: number;
  token?: string;
};

export class GithubImportProvider implements ImportProvider {
  constructor(private readonly client: SafeHttpClient, private readonly options: GithubProviderOptions) {}

  supports(kind: CreateImportSourceRequest["kind"]): boolean {
    return kind === "github_snapshot";
  }

  async freeze(request: Extract<CreateImportSourceRequest, { kind: "github_snapshot" }>, signal?: AbortSignal): Promise<FrozenImport> {
    const [owner, repo] = request.repository.split("/");
    const headers: Record<string, string> = { accept: "application/vnd.github+json" };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    const api = (path: string, maximumBytes = this.options.maximumBytes) => this.client.get(`https://api.github.com${path}`, {
      maximumBytes,
      timeoutMs: this.options.timeoutMs,
      maximumRedirects: this.options.maximumRedirects,
      allowedHosts: ["api.github.com"],
      allowedMediaTypes: [/^application\/json$/u],
      headers,
      signal,
    });
    const commitResponse = await api(`/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/commits/${encodeURIComponent(request.ref)}`, 2 * 1024 * 1024);
    const commit = parseJson(commitResponse.body, "GitHub commit response");
    const commitSha = stringValue(commit.sha);
    if (!/^[0-9a-f]{40}$/iu.test(commitSha)) throw new TerminalImportError("GITHUB_COMMIT_INVALID", "GitHub did not return a valid commit SHA");
    const treeSha = stringValue((commit.commit as Record<string, unknown> | undefined)?.tree && ((commit.commit as Record<string, unknown>).tree as Record<string, unknown>).sha);
    if (!/^[0-9a-f]{40}$/iu.test(treeSha)) throw new TerminalImportError("GITHUB_TREE_INVALID", "GitHub did not return a valid tree SHA");
    const treeResponse = await api(`/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/git/trees/${treeSha}?recursive=1`, 10 * 1024 * 1024);
    const tree = parseJson(treeResponse.body, "GitHub tree response");
    if (tree.truncated === true) throw new TerminalImportError("GITHUB_TREE_TRUNCATED", "The GitHub repository tree is too large to freeze safely");
    const entries = Array.isArray(tree.tree) ? tree.tree.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string")) : [];
    const maximumFiles = Math.min(this.options.maximumFiles, maximumImportSourceManifestBlobs);
    const importable = entries.filter((entry) => isImportablePath(String(entry.path))).sort((left, right) => String(left.path).localeCompare(String(right.path)));
    const selected = importable.slice(0, maximumFiles);
    if (selected.length === 0) throw new TerminalImportError("GITHUB_NO_IMPORTABLE_FILES", "The repository has no importable files");
    if (importable.length > maximumFiles) throw new TerminalImportError("GITHUB_FILE_LIMIT", "The repository contains too many importable files");
    const blobs = [] as Array<{ path: string; mediaType: string; bytes: Buffer }>;
    let total = 0;
    for (const entry of selected) {
      const path = String(entry.path);
      const blobSha = String(entry.sha);
      if (!/^[0-9a-f]{40}$/iu.test(blobSha)) throw new TerminalImportError("GITHUB_BLOB_INVALID", "GitHub did not return a valid file SHA");
      const authenticated = Boolean(this.options.token);
      const sourceUrl = authenticated
        ? `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/git/blobs/${blobSha}`
        : `https://raw.githubusercontent.com/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const response = await this.client.get(sourceUrl, {
        maximumBytes: Math.min(this.options.maximumBytes - total, 10 * 1024 * 1024),
        timeoutMs: this.options.timeoutMs,
        maximumRedirects: this.options.maximumRedirects,
        allowedHosts: [authenticated ? "api.github.com" : "raw.githubusercontent.com"],
        headers: authenticated
          ? { accept: "application/vnd.github.raw+json", authorization: `Bearer ${this.options.token}` }
          : undefined,
        signal,
      });
      total += response.body.byteLength;
      if (total > this.options.maximumBytes) throw new TerminalImportError("GITHUB_SIZE_LIMIT", "The repository exceeds the import size limit");
      blobs.push({ path, mediaType: authenticated ? mediaTypeForPath(path) : response.mediaType ?? mediaTypeForPath(path), bytes: response.body });
    }
    return freezeImport({
      label: request.label ?? `${request.repository}@${commitSha.slice(0, 12)}`,
      descriptor: { kind: "github_snapshot", repository: request.repository, commitSha },
      blobs,
    });
  }
}

function parseJson(bytes: Buffer, label: string) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object") throw new Error("object required");
    return value as Record<string, any>;
  } catch (error) {
    throw new TerminalImportError("GITHUB_RESPONSE_INVALID", `${label} was invalid`, { cause: error });
  }
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TerminalImportError("GITHUB_RESPONSE_INVALID", "GitHub response omitted a required string");
  return value;
}

function isImportablePath(path: string) {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) return false;
  if (path.startsWith(".git/") || path.includes("/node_modules/") || path.includes("/dist/") || path.includes("/build/")) return false;
  return !/\.(lock|map|min\.js|min\.css)$/iu.test(path);
}

function mediaTypeForPath(path: string) {
  const extension = path.toLowerCase().split(".").pop();
  return ({
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", json: "application/json", md: "text/markdown", txt: "text/plain", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

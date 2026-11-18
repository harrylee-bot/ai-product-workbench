import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";

const websiteHost = "studio-import.example.test";
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const repository = "workbench-fixtures/source-material";
const ref = "approved";
const fileKey = "WorkbenchFixture";
const versionId = "42";
const html = "<!doctype html><title>Channel fixture</title><h1>Activity channels</h1>";
const markdown = "# Activity channels\n\nUse existing channel permissions.\n";
const figma = JSON.stringify({ document: { id: "0:0", name: "Activity channels", type: "DOCUMENT", children: [] } });

export const externalImportCases = [
  { kind: "url_snapshot", locator: `https://${websiteHost}/reference`, descriptor: { kind: "url_snapshot", sourceUrl: `https://${websiteHost}/reference`, resolvedUrl: `https://${websiteHost}/final` }, blobs: [{ path: "index.html", body: html }] },
  { kind: "github_snapshot", locator: repository, ref, descriptor: { kind: "github_snapshot", repository, commitSha }, blobs: [{ path: "README.md", body: markdown }] },
  { kind: "figma_snapshot", locator: fileKey, descriptor: { kind: "figma_snapshot", fileKey, versionId }, blobs: [{ path: "figma.json", body: figma }] },
];

const logicalHosts = new Set([websiteHost, "api.github.com", "api.figma.com"]);
export const missingWebsite = `https://${websiteHost}/missing`;

export function createLoopbackImportClient(SafeHttpClient, fixtureOrigin) {
  const origin = new URL(fixtureOrigin);
  assert.ok(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port && origin.pathname === "/" && !origin.search && !origin.hash && !origin.username && !origin.password);
  return new SafeHttpClient(
    async (hostname) => {
      assert.ok(logicalHosts.has(hostname), "Only registered fixture hostnames may be resolved");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    () => (options, callback) => {
      assert.ok(logicalHosts.has(options.hostname), "Only registered fixture hostnames may be fetched");
      return request({
        protocol: "http:", hostname: origin.hostname, port: origin.port,
        method: options.method, path: options.path, timeout: options.timeout,
        headers: { ...options.headers, "X-Studio-Fixture-Upstream": options.hostname },
      }, callback);
    },
  );
}

export async function startImportFixtures() {
  const githubToken = randomBytes(16).toString("hex");
  const figmaToken = randomBytes(16).toString("hex");
  const catalogToken = randomBytes(16).toString("hex");
  const upstreamCalls = [];
  const modelCalls = [];
  const server = createServer((incoming, response) => {
    const json = (value, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    const text = (value, mediaType) => response.writeHead(200, { "Content-Type": mediaType }).end(value);
    const host = incoming.headers["x-studio-fixture-upstream"];
    const route = incoming.url;
    if (!host) {
      modelCalls.push({ method: incoming.method, route });
      if (incoming.method === "GET" && route === "/api/models" && incoming.headers["x-deerflow-internal-token"] === catalogToken) {
        return json({
          models: [{ name: "deepseek-flash", model: "deepseek-4.1-flash", display_name: "DeepSeek Flash", description: "Local catalog fixture", supports_thinking: false, supports_reasoning_effort: false }],
          token_usage: { enabled: false },
        });
      }
      return json({ error: "This suite does not execute a model" }, 503);
    }
    const authenticated = host === "api.github.com"
      ? incoming.headers.authorization === `Bearer ${githubToken}`
      : host === "api.figma.com" ? incoming.headers["x-figma-token"] === figmaToken : false;
    upstreamCalls.push({ host, route, authenticated });
    if (incoming.method !== "GET") return json({}, 405);
    if (host === websiteHost) {
      if (route === "/reference") return response.writeHead(302, { Location: "/final" }).end();
      if (route === "/final") return text(html, "text/html");
    }
    if (host === "api.github.com" && authenticated) {
      if (route === `/repos/${repository}/commits/${ref}`) return json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
      if (route === `/repos/${repository}/git/trees/${treeSha}?recursive=1`) return json({ tree: [{ type: "blob", path: "README.md", sha: blobSha }], truncated: false });
      if (route === `/repos/${repository}/git/blobs/${blobSha}`) return text(markdown, "text/markdown");
    }
    if (host === "api.figma.com" && authenticated) {
      if (route === `/v1/files/${fileKey}/versions`) return json({ versions: [{ id: versionId }] });
      if (route === `/v1/files/${fileKey}?version=${versionId}`) return text(figma, "application/json");
    }
    return json({}, 404);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    githubToken, figmaToken, catalogToken, upstreamCalls, modelCalls,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

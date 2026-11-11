import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { canonicalJson } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";
import { buildExport, buildSourcePrototype } from "../src/index.js";
import { exportRequest } from "./fixtures.js";

const repositoryPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

describe("downloaded React project dependency security", () => {
  it.each(["legacy", "source"] as const)("keeps the %s ZIP on the repository's exact patched Vite version", async (kind) => {
    const request = exportRequest("react");
    if (kind === "source") {
      const content = await buildSourcePrototype({
        protocol: "workbench.prototype-source-input.v1", documentId: "export-toolchain", title: "Toolchain", revision: 1,
        summary: "Verify standalone source dependencies", entryFile: "src/App.tsx",
        files: [{ path: "src/App.tsx", content: "export default function App(){return <h1>Toolchain</h1>}" }],
        pages: [{ id: "home", name: "Home", route: "/" }],
      });
      const artifact = request.source.artifacts[0]!;
      Object.assign(artifact, { kind: "prototype", schemaVersion: 2, content, assets: [],
        checksum: createHash("sha256").update(canonicalJson(content)).digest("hex") });
      request.selection = { kind: "artifact", artifactId: artifact.artifactId, artifactVersionId: artifact.artifactVersionId };
    }
    const archive = unzipSync((await buildExport(request)).bytes);
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(archive["package.json"]!));
    expect(manifest.devDependencies.vite).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.devDependencies.vite).toBe(repositoryPackage.overrides.vite);
    expect(manifest.devDependencies.vite).toBe("8.1.6");
  }, 30_000);
});

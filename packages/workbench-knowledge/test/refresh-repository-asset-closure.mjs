// Run locally after Vault/source-asset edits are complete:
// node packages/workbench-knowledge/test/refresh-repository-asset-closure.mjs
// This verifies local files through the repository auditor; it never publishes a release.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditKnowledgeVault } from "../../../scripts/knowledge-vault-audit.mjs";

const vaultRoot = fileURLToPath(new URL("../../../knowledge-vault", import.meta.url));
const storageRoot = fileURLToPath(new URL("../../../storage", import.meta.url));
const fixturePath = fileURLToPath(new URL("./fixtures/knowledge-storage-asset-closure.v1.json", import.meta.url));
const before = await vaultSnapshot(vaultRoot);
const report = await auditKnowledgeVault({ vaultRoot, storageRoot });
assert.equal(report.passed, true, report.errors.join("\n"));
assert.deepEqual(report.assetClosure.unresolvedAssets, []);
assert.deepEqual(report.assetClosure.rejectedReferences, []);
assert.deepEqual(await vaultSnapshot(vaultRoot), before, "Vault changed during asset verification; retry after edits finish");

const assets = report.assetClosure.referencedAssets.map(({ path, mediaType, byteSize, sha256, symbolicLink }) => ({
  path, mediaType, byteSize, sha256, symbolicLink,
}));
assert.equal(new Set(assets.map((asset) => asset.path)).size, assets.length);
assert.equal(assets.length, report.assetClosure.referencedAssetCount);
for (const asset of assets) {
  assert(Number.isSafeInteger(asset.byteSize) && asset.byteSize >= 0);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
}
const totalBytes = assets.reduce((total, asset) => total + asset.byteSize, 0);
assert(Number.isSafeInteger(totalBytes));
assert.equal(totalBytes, report.assetClosure.referencedBytes);
const fixture = { schema: "workbench.knowledge-asset-closure.v1", totalBytes, assets };
const temporaryPath = `${fixturePath}.${process.pid}.tmp`;
await writeFile(temporaryPath, `${JSON.stringify(fixture, null, 2)}\n`);
await rename(temporaryPath, fixturePath);
console.log(JSON.stringify({ fixture: fixturePath, assets: assets.length, totalBytes, unresolvedAssets: 0 }));

async function vaultSnapshot(directory, relativePath = "") {
  const snapshot = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    const sourcePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) snapshot.push(...await vaultSnapshot(absolutePath, sourcePath));
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      snapshot.push([sourcePath, createHash("sha256").update(await readFile(absolutePath)).digest("hex")]);
    }
  }
  return snapshot.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

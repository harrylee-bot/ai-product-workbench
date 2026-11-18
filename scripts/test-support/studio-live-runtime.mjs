import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function verifyStudioRuntime(root, commit, proofPath) {
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  const dockerfile = await readFile(path.join(root,"integrations/deerflow/Dockerfile"),"utf8");
  const patch = dockerfile.match(/^COPY (integrations\/deerflow\/source-patches\/[a-f0-9]+)\//m)?.[1];
  assert.ok(patch);
  assert.equal(proof.backendCommit,commit);
  assert.equal(proof.imageRevision,commit);
  assert.match(proof.imageId,/^sha256:[0-9a-f]{64}$/);
  assert.match(proof.containerId,/^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(proof.inspectedAt)));
  const manifest = await readFile(path.join(root,patch,"manifest.json"));
  const sourceManifestSha256 = createHash("sha256").update(manifest).digest("hex");
  assert.equal(proof.sourceManifestSha256,sourceManifestSha256);
  const installed = new Map(proof.files.map(file => [file.path,file.sha256]));
  let checked = 0;
  for (const [source, destination] of [
    ["integrations/deerflow/skills/workbench/", "/app/skills/public/workbench/"],
    ["integrations/deerflow/skills/requirement-doc-template/", "/app/skills/public/requirement-doc-template/"],
    ["integrations/deerflow/runtime-tools/deerflow_workbench_tools/", "/app/backend/deerflow_workbench_tools/"],
    [patch+"/", "/opt/workbench/deerflow/source-patch/"],
    ["deploy/deerflow-extensions.production.json", "/app/backend/extensions_config.workbench.json"],
    ["integrations/deerflow/runtime-tools/config.fragment.yaml", "/opt/workbench/deerflow/config.fragment.yaml"],
  ]) {
    const files = execFileSync("git", ["ls-tree","-rz","--name-only",commit,"--",source], {cwd:root,encoding:"utf8"}).split("\0").filter(Boolean);
    assert.ok(files.length,"Missing Runtime source: "+source);
    for (const file of files) {
      const content = execFileSync("git",["show",commit+":"+file],{cwd:root,maxBuffer:16*1024*1024});
      const target = destination+file.slice(source.length);
      assert.equal(installed.get(target),createHash("sha256").update(content).digest("hex"),"Installed Runtime mismatch: "+target);
      checked++;
    }
  }
  assert.equal(checked,installed.size);
  return {backendCommit:commit, containerId:proof.containerId, imageId:proof.imageId,
    inspectedAt:proof.inspectedAt, sourceManifestSha256, verifiedFiles:checked};
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OASDIFF_VERSION,
  acceptedVersionOutput,
  artifactFor,
  resolveOasdiff,
  sha256File,
} from "./resolve-oasdiff.mjs";

test("pins the approved oasdiff release artifacts by platform and architecture", () => {
  assert.equal(OASDIFF_VERSION, "v1.23.0");
  assert.deepEqual(artifactFor("linux", "x64"), {
    file: "oasdiff_1.23.0_linux_amd64.tar.gz",
    sha256: "972b10535c3db4366b9dc3ebc11ca021279af3095267c3cffdca854a3a3c4f89",
    url: "https://github.com/oasdiff/oasdiff/releases/download/v1.23.0/oasdiff_1.23.0_linux_amd64.tar.gz",
  });
  assert.equal(artifactFor("linux", "arm64").sha256, "dcb5fdf425b4dbf401f2d41befebda6580f5d97ef4acc270006314addc817e2e");
  assert.equal(artifactFor("darwin", "x64").sha256, artifactFor("darwin", "arm64").sha256);
  assert.throws(() => artifactFor("win32", "x64"), /no approved artifact/u);
});

test("accepts only the pinned oasdiff version output", () => {
  assert.equal(acceptedVersionOutput("oasdiff version v1.23.0\n"), true);
  assert.equal(acceptedVersionOutput("oasdiff version 1.23.0"), true);
  assert.equal(acceptedVersionOutput("oasdiff version v1.22.0"), false);
  assert.equal(acceptedVersionOutput("v1.23.0"), false);
});

test("computes a deterministic SHA-256 for cached artifacts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-oasdiff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "artifact");
  await writeFile(file, "pinned artifact\n");
  assert.equal(await sha256File(file), "3bb3644b0e440d678b7911a69240bb50659505e6173d0ffa3cfe612a7fe2c2da");
});

test("downloads, verifies, caches, and atomically installs the pinned archive", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-oasdiff-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, "payload");
  const archive = path.join(root, "fixture.tar.gz");
  await mkdir(payload);
  await writeFile(
    path.join(payload, "oasdiff"),
    `#!/bin/sh\nprintf '%s\\n' 'oasdiff version ${OASDIFF_VERSION}'\n`,
  );
  await chmod(path.join(payload, "oasdiff"), 0o755);
  const tar = spawnSync("tar", ["-czf", archive, "-C", payload, "oasdiff"], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const archiveBytes = await readFile(archive);
  const descriptor = {
    file: "oasdiff-fixture.tar.gz",
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    url: "https://fixtures.invalid/oasdiff-fixture.tar.gz",
  };
  let downloads = 0;
  const fetchImpl = async () => {
    downloads += 1;
    return new Response(archiveBytes, { status: 200 });
  };
  const env = { WORKBENCH_TOOL_CACHE_DIR: path.join(root, "cache") };

  const installed = await resolveOasdiff({ env, artifact: descriptor, fetchImpl });
  assert.equal(downloads, 1);
  assert.equal(spawnSync(installed, ["-v"], { encoding: "utf8" }).stdout.trim(), `oasdiff version ${OASDIFF_VERSION}`);

  assert.equal(await resolveOasdiff({ env, artifact: descriptor, fetchImpl }), installed);
  assert.equal(downloads, 1, "a checksum-valid cached archive should not be downloaded again");
});

test("rejects an archive whose bytes do not match the pinned digest", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-oasdiff-integrity-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    resolveOasdiff({
      env: { WORKBENCH_TOOL_CACHE_DIR: path.join(root, "cache") },
      artifact: {
        file: "oasdiff-fixture.tar.gz",
        sha256: "0".repeat(64),
        url: "https://fixtures.invalid/oasdiff-fixture.tar.gz",
      },
      fetchImpl: async () => new Response("not the approved archive", { status: 200 }),
    }),
    /archive SHA-256 mismatch/u,
  );
});

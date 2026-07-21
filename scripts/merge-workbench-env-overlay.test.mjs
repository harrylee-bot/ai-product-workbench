import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mergeEnvironmentOverlay } from "./merge-workbench-env-overlay.mjs";

test("replaces only existing assignments while preserving base layout", () => {
  const base = "# production\nFIRST=old\nSECRET=old=value\nLAST=keep\n";
  const overlay = "FIRST=new\nSECRET=new=value=with=separators\n";

  assert.equal(
    mergeEnvironmentOverlay(base, overlay),
    "# production\nFIRST=new\nSECRET=new=value=with=separators\nLAST=keep\n",
  );
});

test("fails closed on missing, duplicate, empty, or malformed overlay entries", () => {
  assert.throws(
    () => mergeEnvironmentOverlay("KNOWN=value\n", "UNKNOWN=value\n"),
    /UNKNOWN does not exist/u,
  );
  assert.throws(
    () => mergeEnvironmentOverlay("KNOWN=one\nKNOWN=two\n", "KNOWN=new\n"),
    /base contains duplicate KNOWN/u,
  );
  assert.throws(
    () => mergeEnvironmentOverlay("KNOWN=one\n", "KNOWN=one\nKNOWN=two\n"),
    /overlay contains duplicate KNOWN/u,
  );
  assert.throws(() => mergeEnvironmentOverlay("KNOWN=one\n", "# none\n"), /no assignments/u);
  assert.throws(() => mergeEnvironmentOverlay("KNOWN=one\n", "bad-name=value\n"), /invalid name/u);
});

test("adds only explicitly allowed new assignments", () => {
  assert.equal(
    mergeEnvironmentOverlay("KNOWN=old\n", "KNOWN=new\nADDED=value\n", {
      allowedNewNames: ["ADDED"],
    }),
    "KNOWN=new\nADDED=value\n",
  );
  assert.throws(
    () => mergeEnvironmentOverlay("KNOWN=old\n", "OTHER=value\n", {
      allowedNewNames: ["ADDED"],
    }),
    /OTHER does not exist/u,
  );
  assert.throws(
    () => mergeEnvironmentOverlay("KNOWN=old\n", "KNOWN=new\n", {
      allowedNewNames: ["bad-name"],
    }),
    /invalid allowed new name/u,
  );
});

test("CLI creates a new mode-0600 file and refuses overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-env-overlay-"));
  const base = join(directory, "base.env");
  const overlay = join(directory, "overlay.env");
  const output = join(directory, "merged.env");
  writeFileSync(base, "KEY=old\n");
  writeFileSync(overlay, "KEY=new\n");

  execFileSync(process.execPath, [
    "scripts/merge-workbench-env-overlay.mjs",
    "--base",
    base,
    "--overlay",
    overlay,
    "--output",
    output,
  ]);
  assert.equal(readFileSync(output, "utf8"), "KEY=new\n");
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => execFileSync(process.execPath, [
    "scripts/merge-workbench-env-overlay.mjs",
    "--base",
    base,
    "--overlay",
    overlay,
    "--output",
    output,
  ], { stdio: "pipe" }));
});

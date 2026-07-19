#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { canonicalSha256 } from "@workbench/workbench-knowledge";

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("Pass at least one probe JSON path");

for (const path of paths) {
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > 2 * 1024 * 1024) {
    throw new Error(`Probe file size is invalid: ${path}`);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  console.log(`${canonicalSha256(value)}  ${path}`);
}

#!/usr/bin/env node

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runtime images execute installed code directly and never install packages.
// Preserve /app/node_modules, Node itself, and the image entrypoint.
export function removeNodePackageManagers(root = "/") {
  const names = [
    "usr/local/lib/node_modules/npm", "usr/local/lib/node_modules/corepack",
    "root/.npm", "root/.cache/node/corepack",
    ...["npm", "npx", "yarn", "yarnpkg", "corepack", "pnpm", "pnpx"].map((name) => `usr/local/bin/${name}`),
  ];
  for (const name of readdirSync(path.join(root, "opt"), { withFileTypes: true })) {
    if (/^yarn-v\d[\w.-]*$/u.test(name.name)) names.push(`opt/${name.name}`);
  }
  for (const name of names) rmSync(path.join(root, name), { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  removeNodePackageManagers(process.argv[2] ?? "/");
}

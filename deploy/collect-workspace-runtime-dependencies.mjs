import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run after npm prune: npm can place production dependencies beside any
// workspace, and their relative paths (including .bin links) must survive COPY.
export function collectWorkspaceRuntimeDependencies(root, destination) {
  mkdirSync(destination, { recursive: true });
  const copied = [];
  for (const group of ["apps", "packages"]) {
    const parent = join(root, group);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspace = join(group, entry.name);
      const source = join(root, workspace, "node_modules");
      if (!existsSync(join(root, workspace, "package.json")) || !existsSync(source)) continue;
      const target = join(destination, workspace, "node_modules");
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, verbatimSymlinks: true });
      copied.push(workspace);
    }
  }
  return copied.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Expected repository root and output directory");
  collectWorkspaceRuntimeDependencies(resolve(process.argv[2]), resolve(process.argv[3]));
}

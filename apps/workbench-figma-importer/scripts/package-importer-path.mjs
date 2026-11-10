import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packageRootFromModuleUrl(moduleUrl) {
  return resolve(fileURLToPath(new URL("..", moduleUrl)));
}

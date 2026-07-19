/* global module */

const workbenchFeatureLayers = Object.freeze([
  "domain",
  "application",
  "api-adapter",
]);

// Add a feature only after its implementation has moved behind one public
// entry and the registered domain/application/API-adapter layers.
const layeredWorkbenchFeatures = Object.freeze([
  "artifacts",
  "board",
  "canvas-media",
  "design-presets",
  "design-systems",
  "exports",
  "files",
  "identity",
  "import-sources",
  "projects",
  "prototype-patches",
  "public-shares",
  "releases",
  "runtime-models",
  "runs",
  "shares",
  "submission-intents",
  "threads",
]);

// New features use a directory index as their only public entry. Existing
// file facades remain registered until their own ownership migrations land.
const directoryEntryWorkbenchFeatures = Object.freeze([
  "artifacts",
  "canvas-media",
  "design-presets",
  "design-systems",
  "exports",
  "files",
  "identity",
  "import-sources",
  "projects",
  "prototype-patches",
  "runtime-models",
  "runs",
  "submission-intents",
  "threads",
]);

module.exports = Object.freeze({
  directoryEntryWorkbenchFeatures,
  layeredWorkbenchFeatures,
  workbenchFeatureLayers,
});

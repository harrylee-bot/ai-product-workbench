const {
  directoryEntryWorkbenchFeatures,
  layeredWorkbenchFeatures,
} = require("./apps/web/workbench-feature-boundaries.cjs");

const workbenchSourcePath = "^(?:app/(?:[(](?:auth|invitation|workbench)[)]|share)/|components/(?:auth|share|workbench)/|lib/workbench/)";

const layeredFeatureRules = layeredWorkbenchFeatures.flatMap((feature) => {
  const escapedFeature = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const featureDirectory = `^lib/workbench/features/${escapedFeature}/`;
  const usesDirectoryEntry = directoryEntryWorkbenchFeatures.includes(feature);

  return [
    {
      name: `workbench-${feature}-imports-through-public-entry`,
      severity: "error",
      comment: `Consumers must import ${feature} through its public entry, never its internal layers.`,
      from: {
        path: workbenchSourcePath,
        pathNot: `^lib/workbench/features/${escapedFeature}(?:[.]ts|/)`,
      },
      to: {
        path: usesDirectoryEntry
          ? `${featureDirectory}(?!index[.]ts$)`
          : featureDirectory,
      },
    },
    {
      name: `workbench-${feature}-domain-is-independent`,
      severity: "error",
      comment: "Feature domain code cannot depend on application orchestration or API adapters.",
      from: {
        path: `${featureDirectory}domain/`,
      },
      to: {
        path: `${featureDirectory}(?:application|api-adapter)/`,
      },
    },
    {
      name: `workbench-${feature}-api-adapter-does-not-depend-on-application`,
      severity: "error",
      comment: "API adapters implement application-facing ports and cannot depend on application orchestration.",
      from: {
        path: `${featureDirectory}api-adapter/`,
      },
      to: {
        path: `${featureDirectory}application/`,
      },
    },
  ];
});

const directoryEntryAdapterRules = directoryEntryWorkbenchFeatures.map((feature) => ({
  name: `workbench-${feature}-adapter-owns-its-transport`,
  severity: "error",
  comment: "A migrated feature adapter must use the typed API client directly, not the aggregate WorkbenchService facade.",
  from: {
    path: `^lib/workbench/features/${feature}/api-adapter/`,
  },
  to: {
    path: "^lib/workbench/features/service[.]ts$",
  },
}));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...layeredFeatureRules,
    ...directoryEntryAdapterRules,
    {
      name: "workbench-does-not-reach-legacy-application",
      severity: "error",
      comment: "The greenfield Workbench must remain independently removable from the legacy chat application.",
      from: {
        path: workbenchSourcePath,
      },
      to: {
        path: "^(?:components/(?:ai-elements|chat)/|hooks/(?:use-active-chat|use-auto-resume|use-messages)(?:[.]|/)|lib/(?:ai|db)/|lib/(?:chat-fetch|errors|types)[.])",
        reachable: true,
      },
    },
    {
      name: "workbench-does-not-import-database-layer",
      severity: "error",
      comment: "Workbench product code must use the typed API boundary instead of importing database clients or repositories directly.",
      from: {
        path: workbenchSourcePath,
      },
      to: {
        path: "^(?:(?:[.][.]/)*packages/(?:workbench-db|db)/|(?:[.][.]/)*node_modules/(?:@workbench/(?:workbench-db|db)|@prisma/client|prisma|pg|pg-boss)(?:/|$)|(?:@workbench/(?:workbench-db|db)|@prisma/client|prisma|pg|pg-boss)(?:/|$))",
      },
    },
    {
      name: "workbench-does-not-reach-legacy-client-runtime",
      severity: "error",
      comment: "DeerFlow, Workbench RunEvent and TanStack Query are the only new runtime and server-state contracts.",
      from: {
        path: workbenchSourcePath,
      },
      to: {
        path: "^(?:[.][.]/[.][.]/)?node_modules/(?:@ai-sdk/|ai/|swr/)",
        reachable: true,
      },
    },
    {
      name: "workbench-board-domain-does-not-reach-react-flow-runtime",
      severity: "error",
      comment: "Board state receives the upstream change reducers through a port; only Project UI may load React Flow runtime code.",
      from: {
        path: "^lib/workbench/(?:board/(?!.*[.]spec[.])|features/board/domain/)",
      },
      to: {
        path: "^(?:[.][.]/[.][.]/)?node_modules/@xyflow/react",
        reachable: true,
      },
    },
    {
      name: "no-workbench-circular-dependencies",
      severity: "error",
      comment: "Circular feature dependencies obscure ownership and make adapters difficult to replace.",
      from: {
        path: workbenchSourcePath,
      },
      to: {
        circular: true,
      },
    },
    {
      name: "workbench-imports-must-resolve",
      severity: "error",
      from: {
        path: workbenchSourcePath,
      },
      to: {
        couldNotResolve: true,
      },
    },
  ],
  options: {
    combinedDependencies: true,
    doNotFollow: {
      path: "node_modules|^[.][.]/[.][.]/packages(?:/|$)",
    },
    exclude: {
      path: "^(?:[.]next|dist)/|^[.][.]/[.][.]/apps/",
    },
    enhancedResolveOptions: {
      conditionNames: ["import", "require", "browser", "node", "default", "types"],
      exportsFields: ["exports"],
      extensions: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".d.ts"],
      mainFields: ["browser", "module", "main", "types"],
    },
    moduleSystems: ["cjs", "es6"],
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};

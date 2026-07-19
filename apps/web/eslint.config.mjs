import { createRequire } from "node:module";

import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const {
  layeredWorkbenchFeatures,
} = require("./workbench-feature-boundaries.cjs");

const workbenchLintFiles = [
  "components/share/**/*.{ts,tsx}",
  "components/workbench/**/*.{ts,tsx}",
  "lib/workbench/**/*.{ts,tsx}",
];

const workbenchProductLintFiles = [
  "app/(invitation)/**/*.{ts,tsx}",
  "app/(workbench)/**/*.{ts,tsx}",
  "app/share/**/*.{ts,tsx}",
  ...workbenchLintFiles,
];

const authLintFiles = [
  "app/(auth)/**/*.{ts,tsx}",
  "components/auth/**/*.{ts,tsx}",
];

const authRestrictedImportPatterns = [
  {
    group: ["@/components/chat/*", "**/components/chat/*"],
    message: "Authentication UI owns its presentation modules and cannot depend on the legacy chat UI.",
  },
];

const workbenchRestrictedImportPaths = [
  {
    name: "ai",
    message: "Workbench owns its RunEvent and Artifact contracts; do not reintroduce the legacy AI SDK message model.",
  },
  {
    name: "swr",
    message: "TanStack Query is the only server-state cache in the new Workbench.",
  },
];

const databaseRestrictedImportPaths = [
  "@workbench/workbench-db",
  "@prisma/client",
  "prisma",
  "pg",
  "pg-boss",
].map((name) => ({
  name,
  message: "Direct database access belongs behind the Workbench API and repository boundary.",
}));

const databaseRestrictedImportPatterns = [
  {
    group: [
      "@workbench/workbench-db/*",
      "@prisma/client/*",
      "prisma/*",
      "pg/*",
      "pg-boss/*",
      "@/lib/db",
      "@/lib/db/*",
      "**/lib/db",
      "**/lib/db/*",
      "**/packages/workbench-db/*",
    ],
    message: "Direct database access belongs behind the Workbench API and repository boundary.",
  },
];

const databaseDynamicImportMessage = "Dynamic database access belongs behind the Workbench API and repository boundary.";
const databaseDynamicImportExactSpecifiers = [
  "@workbench/workbench-db",
  "@prisma/client",
  "prisma",
  "pg",
  "pg-boss",
];
const databaseDynamicImportPrefixes = [
  "@workbench/workbench-db/",
  "@prisma/client/",
  "prisma/",
  "pg/",
  "pg-boss/",
];
const databaseRestrictedDynamicImports = [
  ...databaseDynamicImportExactSpecifiers.map((specifier) => ({
    selector: `ImportExpression[source.value='${specifier}']`,
    message: databaseDynamicImportMessage,
  })),
  ...databaseDynamicImportPrefixes.map((prefix) => ({
    selector: `ImportExpression[source.value=/^${escapeEsqueryRegex(prefix)}/]`,
    message: databaseDynamicImportMessage,
  })),
  {
    selector: "ImportExpression[source.value=/(?:^|\\/)lib\\/db(?:\\/|$)/]",
    message: databaseDynamicImportMessage,
  },
  {
    selector: "ImportExpression[source.value=/(?:^|\\/)packages\\/(?:workbench-db|db)(?:\\/|$)/]",
    message: databaseDynamicImportMessage,
  },
];

const workbenchRestrictedImportPatterns = [
  {
    group: ["@ai-sdk/*"],
    message: "DeerFlow is the only production runtime; Workbench must not add another AI SDK runtime.",
  },
  {
    group: [
      "@/components/chat/*",
      "@/hooks/use-active-chat",
      "@/hooks/use-auto-resume",
      "@/hooks/use-messages",
      "@/lib/ai/*",
      "@/lib/chat-fetch",
      "@/lib/errors",
      "**/components/chat/*",
      "**/hooks/use-active-chat",
      "**/hooks/use-auto-resume",
      "**/hooks/use-messages",
      "**/lib/ai/*",
      "**/lib/chat-fetch",
      "**/lib/errors",
    ],
    message: "The greenfield Workbench cannot depend on the legacy chat or persistence implementation.",
  },
];

const escapedLayeredFeatures = layeredWorkbenchFeatures
  .map((feature) => feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const layeredFeatureDeepImportPattern = {
  regex: `(?:(?:^|/)features/(?:${escapedLayeredFeatures})/.+|^(?:[.]/|(?:[.][.]/)+)(?:${escapedLayeredFeatures})/.+)`,
  message: "Layered Workbench features expose only their top-level public entry; do not deep-import domain, application, or API-adapter files.",
};

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "next-env.d.ts",
      "node_modules/**",
      "out/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-undef": "off",
    },
  },
  {
    files: authLintFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: databaseRestrictedImportPaths,
          patterns: [
            ...authRestrictedImportPatterns,
            ...databaseRestrictedImportPatterns,
          ],
        },
      ],
    },
  },
  {
    files: workbenchProductLintFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: databaseRestrictedImportPaths,
          patterns: databaseRestrictedImportPatterns,
        },
      ],
    },
  },
  {
    files: workbenchLintFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...workbenchRestrictedImportPaths,
            ...databaseRestrictedImportPaths,
          ],
          patterns: [
            ...workbenchRestrictedImportPatterns,
            ...databaseRestrictedImportPatterns,
          ],
        },
      ],
    },
  },
  {
    files: workbenchLintFiles,
    ignores: layeredWorkbenchFeatures.flatMap((feature) => [
      `lib/workbench/features/${feature}.ts`,
      `lib/workbench/features/${feature}/**/*.{ts,tsx}`,
    ]),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...workbenchRestrictedImportPaths,
            ...databaseRestrictedImportPaths,
          ],
          patterns: [
            ...workbenchRestrictedImportPatterns,
            ...databaseRestrictedImportPatterns,
            layeredFeatureDeepImportPattern,
          ],
        },
      ],
    },
  },
  {
    files: [
      ...authLintFiles,
      ...workbenchProductLintFiles,
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...databaseRestrictedDynamicImports,
      ],
    },
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);

function escapeEsqueryRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

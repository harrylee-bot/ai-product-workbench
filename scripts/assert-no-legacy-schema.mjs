#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";

export function hasLegacySchemaViolations(violations) {
  return violations.columns.length > 0 || violations.tables.length > 0 || violations.types.length > 0;
}

export function formatLegacySchemaViolations(violations) {
  const lines = [];

  if (violations.tables.length > 0) {
    lines.push("Legacy tables:");
    for (const row of violations.tables) {
      lines.push(`  - ${row.table_name}`);
    }
  }

  if (violations.columns.length > 0) {
    lines.push("Legacy columns:");
    for (const row of violations.columns) {
      lines.push(`  - ${row.table_name}.${row.column_name}`);
    }
  }

  if (violations.types.length > 0) {
    lines.push("Legacy enum/types:");
    for (const row of violations.types) {
      lines.push(`  - ${row.typname}`);
    }
  }

  return lines.join("\n");
}

export async function collectLegacySchemaViolations(prisma) {
  const [tables, columns, types] = await Promise.all([
    prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (
          table_name IN ('projects', 'products')
          OR table_name LIKE 'product_design\_%' ESCAPE '\'
        )
      ORDER BY table_name
    `,
    prisma.$queryRaw`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          column_name IN ('project_id', 'source_product_id')
          OR column_name LIKE '%product_design%'
        )
      ORDER BY table_name, column_name
    `,
    prisma.$queryRaw`
      SELECT typname
      FROM pg_type
      WHERE typname IN ('ProductDesignChangeType', 'ProductDesignStateStatus', 'ProjectStatus')
      ORDER BY typname
    `,
  ]);

  return { tables, columns, types };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required to assert the deployed schema.");
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();
  try {
    const violations = await collectLegacySchemaViolations(prisma);
    if (hasLegacySchemaViolations(violations)) {
      console.error("Legacy project/product/product-design schema residue found.");
      console.error(formatLegacySchemaViolations(violations));
      process.exitCode = 1;
      return;
    }

    console.log("No legacy project/product/product-design schema residue found.");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

#!/usr/bin/env node
import { Prisma, PrismaClient } from "@prisma/client";
import { fileURLToPath } from "node:url";

export const REQUIRED_CONVERSATION_COLUMNS = [
  ["comments", "conversation_id"],
  ["constraint_rules", "conversation_id"],
  ["file_assets", "conversation_id"],
  ["file_chunks", "conversation_id"],
  ["file_parse_results", "conversation_id"],
  ["knowledge_candidates", "conversation_id"],
  ["prototype_artifacts", "conversation_id"],
  ["prototype_artifacts", "conversation_design_state_id"],
  ["prototype_artifacts", "conversation_design_state_version"],
  ["prototype_conversion_jobs", "conversation_id"],
  ["prototype_spec_records", "conversation_id"],
  ["prototype_spec_records", "conversation_design_state_id"],
  ["prototype_spec_records", "conversation_design_state_version"],
  ["prototype_versions", "conversation_id"],
  ["qa_reports", "conversation_id"],
  ["qa_reports", "conversation_design_state_id"],
  ["qa_reports", "conversation_design_state_version"],
  ["requirement_document_versions", "conversation_id"],
  ["requirement_documents", "conversation_id"],
  ["requirement_documents", "conversation_design_state_id"],
  ["requirement_documents", "conversation_design_state_version"],
  ["rollback_records", "conversation_id"],
  ["rollback_records", "from_conversation_design_state_version"],
  ["rollback_records", "to_conversation_design_state_version"],
  ["share_links", "conversation_id"],
  ["vibe_stream_event_logs", "conversation_id"],
];

export const REQUIRED_SCHEMA_COLUMNS = [
  {
    table_name: "users",
    column_name: "auth_version",
    udt_name: "int4",
    is_nullable: "NO",
    column_default: "0",
  },
  {
    table_name: "agent_run_logs",
    column_name: "request_id",
    udt_name: "text",
    is_nullable: "YES",
  },
  {
    table_name: "agent_run_logs",
    column_name: "lease_token",
    udt_name: "text",
    is_nullable: "YES",
  },
  {
    table_name: "agent_run_logs",
    column_name: "heartbeat_at",
    udt_name: "timestamp",
    is_nullable: "YES",
  },
  {
    table_name: "agent_run_logs",
    column_name: "lease_expires_at",
    udt_name: "timestamp",
    is_nullable: "YES",
  },
  {
    table_name: "agent_run_logs",
    column_name: "external_run_id",
    udt_name: "text",
    is_nullable: "YES",
  },
];

export const REQUIRED_INDEXES = [
  {
    table_name: "agent_run_logs",
    index_name: "agent_run_logs_conversation_id_request_id_key",
    is_unique: true,
    column_names: ["conversation_id", "request_id"],
  },
  {
    table_name: "agent_run_logs",
    index_name: "agent_run_logs_one_running_per_conversation_key",
    is_unique: true,
    column_names: ["conversation_id"],
    predicate: "status = 'running'",
  },
  {
    table_name: "agent_run_logs",
    index_name: "agent_run_logs_conversation_id_status_idx",
    is_unique: false,
    column_names: ["conversation_id", "status"],
  },
  {
    table_name: "agent_run_logs",
    index_name: "agent_run_logs_lease_expires_at_idx",
    is_unique: false,
    column_names: ["lease_expires_at"],
  },
  {
    table_name: "conversation_design_versions",
    index_name: "conversation_design_versions_state_id_version_key",
    is_unique: true,
    column_names: ["state_id", "version"],
  },
  {
    table_name: "requirement_document_versions",
    index_name: "requirement_document_versions_document_id_version_key",
    is_unique: true,
    column_names: ["document_id", "version"],
  },
  {
    table_name: "prototype_versions",
    index_name: "prototype_versions_artifact_id_version_key",
    is_unique: true,
    column_names: ["artifact_id", "version"],
  },
];

export const REQUIRED_FOREIGN_KEYS = [
  [
    "agent_run_logs",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  ["comments", "conversation_id", "conversations", "id", "CASCADE", "CASCADE"],
  [
    "constraint_rules",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "conversation_design_change_logs",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "conversation_design_change_logs",
    "state_id",
    "conversation_design_states",
    "id",
    "RESTRICT",
    "CASCADE",
  ],
  [
    "conversation_design_states",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "conversation_design_versions",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "conversation_design_versions",
    "state_id",
    "conversation_design_states",
    "id",
    "RESTRICT",
    "CASCADE",
  ],
  [
    "file_assets",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "knowledge_candidates",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "knowledge_items",
    "source_conversation_id",
    "conversations",
    "id",
    "SET NULL",
    "CASCADE",
  ],
  [
    "prototype_artifacts",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "prototype_artifacts",
    "conversation_design_state_id",
    "conversation_design_states",
    "id",
    "RESTRICT",
    "CASCADE",
  ],
  [
    "prototype_conversion_jobs",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "prototype_spec_records",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "prototype_spec_records",
    "conversation_design_state_id",
    "conversation_design_states",
    "id",
    "RESTRICT",
    "CASCADE",
  ],
  [
    "prototype_versions",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "qa_reports",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "requirement_document_versions",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "requirement_documents",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "requirement_documents",
    "conversation_design_state_id",
    "conversation_design_states",
    "id",
    "RESTRICT",
    "CASCADE",
  ],
  [
    "rollback_records",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "share_links",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  [
    "vibe_stream_event_logs",
    "conversation_id",
    "conversations",
    "id",
    "CASCADE",
    "CASCADE",
  ],
  ["votes", "message_id", "messages", "id", "CASCADE", "CASCADE"],
  ["votes", "user_id", "users", "id", "CASCADE", "CASCADE"],
  ["suggestions", "user_id", "users", "id", "CASCADE", "CASCADE"],
];

function expectedEnumContract() {
  return Prisma.dmmf.datamodel.enums.map((definition) => ({
    enum_name: definition.dbName ?? definition.name,
    labels: definition.values.map((value) => value.dbName ?? value.name).sort(),
  }));
}

function expectedTableNames() {
  return Prisma.dmmf.datamodel.models
    .map((model) => model.dbName ?? model.name)
    .sort();
}

export function findEnumLabelViolations(expected, actualRows) {
  const actualByName = new Map();
  for (const row of actualRows) {
    const labels = actualByName.get(row.enum_name) ?? [];
    labels.push(row.enum_label);
    actualByName.set(row.enum_name, labels);
  }

  return expected.flatMap(({ enum_name: enumName, labels }) => {
    const actualLabels = (actualByName.get(enumName) ?? []).sort();
    const expectedLabels = [...labels].sort();
    return JSON.stringify(actualLabels) === JSON.stringify(expectedLabels)
      ? []
      : [
          {
            enum_name: enumName,
            expected_labels: expectedLabels,
            actual_labels: actualLabels,
          },
        ];
  });
}

export function findRequiredColumnViolations(expected, actualRows) {
  const actualByColumn = new Map(
    actualRows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );

  return expected.flatMap(([tableName, columnName]) => {
    const row = actualByColumn.get(`${tableName}.${columnName}`);
    return row?.is_nullable === "NO"
      ? []
      : [
          {
            table_name: tableName,
            column_name: columnName,
            actual_nullable: row?.is_nullable ?? "MISSING",
          },
        ];
  });
}

export function findSchemaColumnViolations(expected, actualRows) {
  const actualByColumn = new Map(
    actualRows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );

  return expected.flatMap((definition) => {
    const row = actualByColumn.get(
      `${definition.table_name}.${definition.column_name}`,
    );
    const defaultMatches =
      definition.column_default === undefined ||
      row?.column_default === definition.column_default;
    const valid =
      row?.udt_name === definition.udt_name &&
      row?.is_nullable === definition.is_nullable &&
      defaultMatches;

    return valid
      ? []
      : [
          {
            ...definition,
            actual_udt_name: row?.udt_name ?? "MISSING",
            actual_nullable: row?.is_nullable ?? "MISSING",
            actual_default: row?.column_default ?? null,
          },
        ];
  });
}

function normalizeIndexPredicate(value) {
  return (value ?? "")
    .replace(/::(?:"[^"]+"|[a-zA-Z0-9_.]+)/g, "")
    .replace(/[()"\s]/g, "")
    .toLowerCase();
}

export function findRequiredIndexViolations(expected, actualRows) {
  const actualByIndex = new Map(
    actualRows.map((row) => [`${row.table_name}.${row.index_name}`, row]),
  );

  return expected.flatMap((definition) => {
    const row = actualByIndex.get(
      `${definition.table_name}.${definition.index_name}`,
    );
    const predicateMatches =
      definition.predicate === undefined
        ? row?.predicate == null
        : normalizeIndexPredicate(row?.predicate) ===
          normalizeIndexPredicate(definition.predicate);
    const valid =
      row?.is_unique === definition.is_unique &&
      JSON.stringify(row?.column_names ?? []) ===
        JSON.stringify(definition.column_names) &&
      predicateMatches;

    return valid
      ? []
      : [
          {
            ...definition,
            actual: row ?? null,
          },
        ];
  });
}

export function findForeignKeyViolations(expected, actualRows) {
  return expected.flatMap(
    ([
      tableName,
      columnName,
      foreignTableName,
      foreignColumnName,
      deleteRule,
      updateRule,
    ]) => {
      const matches = actualRows.filter(
        (row) => row.table_name === tableName && row.column_name === columnName,
      );
      const valid = matches.some(
        (row) =>
          row.foreign_table_name === foreignTableName &&
          row.foreign_column_name === foreignColumnName &&
          row.delete_rule === deleteRule &&
          row.update_rule === updateRule,
      );

      return valid
        ? []
        : [
            {
              table_name: tableName,
              column_name: columnName,
              expected_reference: `${foreignTableName}.${foreignColumnName}`,
              expected_delete_rule: deleteRule,
              expected_update_rule: updateRule,
              actual: matches,
            },
          ];
    },
  );
}

export function hasLegacySchemaViolations(violations) {
  return [
    "columns",
    "tables",
    "types",
    "enumLabels",
    "nullableColumns",
    "foreignKeys",
    "missingTables",
    "schemaColumns",
    "indexes",
  ].some((key) => (violations[key]?.length ?? 0) > 0);
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

  if ((violations.enumLabels?.length ?? 0) > 0) {
    lines.push("Enum label mismatches:");
    for (const row of violations.enumLabels) {
      lines.push(
        `  - ${row.enum_name}: expected [${row.expected_labels.join(", ")}], actual [${row.actual_labels.join(", ")}]`,
      );
    }
  }

  if ((violations.nullableColumns?.length ?? 0) > 0) {
    lines.push("Required columns that are nullable or missing:");
    for (const row of violations.nullableColumns) {
      lines.push(
        `  - ${row.table_name}.${row.column_name} (${row.actual_nullable})`,
      );
    }
  }

  if ((violations.foreignKeys?.length ?? 0) > 0) {
    lines.push("Missing or incorrect foreign keys:");
    for (const row of violations.foreignKeys) {
      lines.push(
        `  - ${row.table_name}.${row.column_name} -> ${row.expected_reference} ON DELETE ${row.expected_delete_rule} ON UPDATE ${row.expected_update_rule}`,
      );
    }
  }

  if ((violations.missingTables?.length ?? 0) > 0) {
    lines.push("Missing Prisma tables:");
    for (const tableName of violations.missingTables) {
      lines.push(`  - ${tableName}`);
    }
  }

  if ((violations.schemaColumns?.length ?? 0) > 0) {
    lines.push("Missing or incorrect runtime schema columns:");
    for (const row of violations.schemaColumns) {
      lines.push(
        `  - ${row.table_name}.${row.column_name}: expected ${row.udt_name} nullable=${row.is_nullable}, actual ${row.actual_udt_name} nullable=${row.actual_nullable}`,
      );
    }
  }

  if ((violations.indexes?.length ?? 0) > 0) {
    lines.push("Missing or incorrect runtime indexes:");
    for (const row of violations.indexes) {
      lines.push(`  - ${row.table_name}.${row.index_name}`);
    }
  }

  return lines.join("\n");
}

export async function collectLegacySchemaViolations(prisma) {
  const [
    tables,
    columns,
    types,
    enumRows,
    databaseColumns,
    foreignKeys,
    databaseTables,
    databaseIndexes,
  ] = await Promise.all([
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
          column_name IN ('project_id', 'source_project_id', 'source_product_id')
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
    prisma.$queryRaw`
      SELECT
        t.typname AS enum_name,
        e.enumlabel AS enum_label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder
    `,
    prisma.$queryRaw`
      SELECT table_name, column_name, is_nullable, udt_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `,
    prisma.$queryRaw`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema
        AND ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = tc.constraint_schema
        AND rc.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
      ORDER BY tc.table_name, kcu.column_name
    `,
    prisma.$queryRaw`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `,
    prisma.$queryRaw`
      SELECT
        table_rel.relname AS table_name,
        index_rel.relname AS index_name,
        index_def.indisunique AS is_unique,
        ARRAY(
          SELECT attribute.attname
          FROM unnest(index_def.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute attribute
            ON attribute.attrelid = table_rel.oid
            AND attribute.attnum = key.attnum
          ORDER BY key.position
        ) AS column_names,
        pg_get_expr(index_def.indpred, index_def.indrelid) AS predicate
      FROM pg_index index_def
      JOIN pg_class table_rel ON table_rel.oid = index_def.indrelid
      JOIN pg_class index_rel ON index_rel.oid = index_def.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
      WHERE namespace.nspname = 'public'
      ORDER BY table_rel.relname, index_rel.relname
    `,
  ]);

  const actualTableNames = new Set(databaseTables.map((row) => row.table_name));
  return {
    tables,
    columns,
    types,
    enumLabels: findEnumLabelViolations(expectedEnumContract(), enumRows),
    nullableColumns: findRequiredColumnViolations(
      REQUIRED_CONVERSATION_COLUMNS,
      databaseColumns,
    ),
    foreignKeys: findForeignKeyViolations(REQUIRED_FOREIGN_KEYS, foreignKeys),
    missingTables: expectedTableNames().filter(
      (tableName) => !actualTableNames.has(tableName),
    ),
    schemaColumns: findSchemaColumnViolations(
      REQUIRED_SCHEMA_COLUMNS,
      databaseColumns,
    ),
    indexes: findRequiredIndexViolations(REQUIRED_INDEXES, databaseIndexes),
  };
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
      console.error(
        "Deployed database does not match the Prisma schema contract.",
      );
      console.error(formatLegacySchemaViolations(violations));
      process.exitCode = 1;
      return;
    }

    console.log(
      "Deployed database matches the conversation-first Prisma schema contract.",
    );
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

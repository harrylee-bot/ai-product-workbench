#!/usr/bin/env node
import { PrismaClient } from "@prisma/client";

const SMOKE_TITLE_PREDICATES = [
  "title LIKE '本地全链路审计%'",
  "title LIKE 'Codex 线上冒烟%'",
  "title LIKE 'Codex 本地冒烟%'",
];

const USER_PREDICATES = [
  "username LIKE 'audit#_current#_%' ESCAPE '#'",
  "username LIKE 'codex#_prod#_smoke#_%' ESCAPE '#'",
  "username LIKE 'codex#_local#_smoke#_%' ESCAPE '#'",
  "email LIKE 'audit-current-%@example.test'",
  "email LIKE 'audit#_%@example.test' ESCAPE '#'",
  "email LIKE 'codex#_prod#_smoke#_%' ESCAPE '#'",
  "email LIKE 'codex#_local#_smoke#_%' ESCAPE '#'",
];

const SHARE_TOKEN_PREDICATES = [
  "token LIKE 'codex#_%' ESCAPE '#'",
];

const TARGET_CTES = `
WITH target_users AS (
  SELECT id FROM users WHERE ${USER_PREDICATES.join(" OR ")}
),
target_conversations AS (
  SELECT id FROM conversations
  WHERE owner_id IN (SELECT id FROM target_users)
     OR ${SMOKE_TITLE_PREDICATES.join(" OR ")}
),
target_messages AS (
  SELECT id FROM messages WHERE conversation_id IN (SELECT id FROM target_conversations)
),
target_runs AS (
  SELECT id FROM agent_run_logs WHERE conversation_id IN (SELECT id FROM target_conversations)
),
target_file_assets AS (
  SELECT id FROM file_assets
  WHERE conversation_id IN (SELECT id FROM target_conversations)
     OR uploaded_by IN (SELECT id FROM target_users)
),
target_knowledge_items AS (
  SELECT id FROM knowledge_items
  WHERE source_conversation_id IN (SELECT id FROM target_conversations)
     OR created_by IN (SELECT id FROM target_users)
),
target_share_links AS (
  SELECT id FROM share_links
  WHERE conversation_id IN (SELECT id FROM target_conversations)
     OR ${SHARE_TOKEN_PREDICATES.join(" OR ")}
)
`;

const DELETE_STATEMENTS = [
  "DELETE FROM comments WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR user_id IN (SELECT id FROM _smoke_user_ids) OR resolved_by IN (SELECT id FROM _smoke_user_ids)",
  "DELETE FROM suggestions WHERE user_id IN (SELECT id FROM _smoke_user_ids)",
  "DELETE FROM votes WHERE user_id IN (SELECT id FROM _smoke_user_ids) OR message_id IN (SELECT id FROM _smoke_message_ids)",
  "DELETE FROM knowledge_versions WHERE knowledge_item_id IN (SELECT id FROM _smoke_knowledge_item_ids)",
  "DELETE FROM knowledge_items WHERE id IN (SELECT id FROM _smoke_knowledge_item_ids)",
  "DELETE FROM knowledge_candidates WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM knowledge_retrieval_logs WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR run_id IN (SELECT id FROM _smoke_run_ids)",
  "DELETE FROM vibe_stream_event_logs WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR run_id IN (SELECT id FROM _smoke_run_ids)",
  "DELETE FROM agent_step_logs WHERE run_id IN (SELECT id FROM _smoke_run_ids)",
  "DELETE FROM model_call_logs WHERE run_id IN (SELECT id FROM _smoke_run_ids)",
  "DELETE FROM agent_run_logs WHERE id IN (SELECT id FROM _smoke_run_ids)",
  "DELETE FROM deerflow_thread_bindings WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR user_id IN (SELECT id FROM _smoke_user_ids)",
  "DELETE FROM share_links WHERE id IN (SELECT id FROM _smoke_share_ids)",
  "DELETE FROM rollback_records WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM qa_reports WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM prototype_versions WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR artifact_id IN (SELECT id FROM prototype_artifacts WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids))",
  "DELETE FROM prototype_artifacts WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM prototype_spec_records WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM requirement_document_versions WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR document_id IN (SELECT id FROM requirement_documents WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids))",
  "DELETE FROM requirement_documents WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM conversation_design_change_logs WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM conversation_design_versions WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM conversation_design_states WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM prototype_conversion_jobs WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR file_asset_id IN (SELECT id FROM _smoke_file_asset_ids)",
  "DELETE FROM file_chunks WHERE file_asset_id IN (SELECT id FROM _smoke_file_asset_ids)",
  "DELETE FROM file_parse_results WHERE file_asset_id IN (SELECT id FROM _smoke_file_asset_ids)",
  "DELETE FROM file_assets WHERE id IN (SELECT id FROM _smoke_file_asset_ids)",
  "DELETE FROM constraint_rules WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM messages WHERE id IN (SELECT id FROM _smoke_message_ids)",
  "DELETE FROM streams WHERE chat_id IN (SELECT id FROM _smoke_conversation_ids)",
  `DELETE FROM login_audit_logs
    WHERE user_id IN (SELECT id FROM _smoke_user_ids)
       OR account LIKE 'audit-current-%@example.test'
       OR account LIKE 'audit#_%@example.test' ESCAPE '#'
       OR account LIKE 'codex#_prod#_smoke#_%' ESCAPE '#'
       OR account LIKE 'codex#_local#_smoke#_%' ESCAPE '#'`,
  "DELETE FROM admin_audit_logs WHERE admin_user_id IN (SELECT id FROM _smoke_user_ids)",
  "DELETE FROM conversations WHERE id IN (SELECT id FROM _smoke_conversation_ids)",
  "DELETE FROM users WHERE id IN (SELECT id FROM _smoke_user_ids)",
];

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    skipGateway: argv.includes("--skip-gateway"),
    json: argv.includes("--json"),
  };
}

function toCountMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]));
}

function statementLabel(statement) {
  const compact = statement.replace(/\s+/g, " ").trim();
  const match = /^DELETE FROM\s+(\S+)/i.exec(compact);
  return match ? `DELETE FROM ${match[1]}` : compact;
}

export async function collectSmokeCounts(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    ${TARGET_CTES}
    SELECT 'users' AS name, count(*)::int AS count FROM target_users
    UNION ALL SELECT 'conversations', count(*)::int FROM target_conversations
    UNION ALL SELECT 'messages', count(*)::int FROM target_messages
    UNION ALL SELECT 'agent_run_logs', count(*)::int FROM target_runs
    UNION ALL SELECT 'file_assets', count(*)::int FROM target_file_assets
    UNION ALL SELECT 'knowledge_items', count(*)::int FROM target_knowledge_items
    UNION ALL SELECT 'share_links', count(*)::int FROM target_share_links
    UNION ALL SELECT 'deerflow_thread_bindings', count(*)::int FROM deerflow_thread_bindings
      WHERE conversation_id IN (SELECT id FROM target_conversations)
         OR user_id IN (SELECT id FROM target_users)
  `);

  return toCountMap(rows);
}

async function collectDeerFlowThreadIds(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    ${TARGET_CTES}
    SELECT deerflow_thread_id
    FROM deerflow_thread_bindings
    WHERE conversation_id IN (SELECT id FROM target_conversations)
       OR user_id IN (SELECT id FROM target_users)
    ORDER BY deerflow_thread_id
  `);

  return rows.map((row) => row.deerflow_thread_id);
}

async function createTargetTables(tx) {
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE _smoke_user_ids ON COMMIT DROP AS SELECT id FROM users WHERE ${USER_PREDICATES.join(" OR ")}`);
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE _smoke_conversation_ids ON COMMIT DROP AS
    SELECT id FROM conversations
    WHERE owner_id IN (SELECT id FROM _smoke_user_ids)
       OR ${SMOKE_TITLE_PREDICATES.join(" OR ")}
  `);
  await tx.$executeRawUnsafe("CREATE TEMP TABLE _smoke_message_ids ON COMMIT DROP AS SELECT id FROM messages WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)");
  await tx.$executeRawUnsafe("CREATE TEMP TABLE _smoke_run_ids ON COMMIT DROP AS SELECT id FROM agent_run_logs WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids)");
  await tx.$executeRawUnsafe("CREATE TEMP TABLE _smoke_file_asset_ids ON COMMIT DROP AS SELECT id FROM file_assets WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR uploaded_by IN (SELECT id FROM _smoke_user_ids)");
  await tx.$executeRawUnsafe("CREATE TEMP TABLE _smoke_knowledge_item_ids ON COMMIT DROP AS SELECT id FROM knowledge_items WHERE source_conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR created_by IN (SELECT id FROM _smoke_user_ids)");
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE _smoke_share_ids ON COMMIT DROP AS SELECT id FROM share_links WHERE conversation_id IN (SELECT id FROM _smoke_conversation_ids) OR ${SHARE_TOKEN_PREDICATES.join(" OR ")}`);
}

export async function deleteSmokeData(prisma) {
  const deleted = [];
  await prisma.$transaction(async (tx) => {
    await createTargetTables(tx);

    for (const statement of DELETE_STATEMENTS) {
      const count = await tx.$executeRawUnsafe(statement);
      deleted.push({ statement: statementLabel(statement), count: Number(count) });
    }
  });
  return deleted;
}

async function deleteGatewayThreads(threadIds, options) {
  if (options.skipGateway || threadIds.length === 0) {
    return [];
  }

  const gatewayUrl = (process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001").replace(/\/$/, "");
  const results = [];
  for (const threadId of threadIds) {
    const url = `${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}`;
    try {
      const response = await fetch(url, { method: "DELETE" });
      results.push({ threadId, status: response.status, ok: response.ok || response.status === 404 });
    } catch (error) {
      results.push({ threadId, status: "network_error", ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

function printSummary(summary, asJson) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Mode: ${summary.dryRun ? "dry-run" : "delete"}`);
  console.log("Before:");
  for (const [name, count] of Object.entries(summary.before)) {
    console.log(`  ${name}: ${count}`);
  }
  if (summary.gateway.length > 0) {
    console.log("Gateway threads:");
    for (const item of summary.gateway) {
      console.log(`  ${item.threadId}: ${item.status}`);
    }
  }
  if (!summary.dryRun) {
    console.log("After:");
    for (const [name, count] of Object.entries(summary.after)) {
      console.log(`  ${name}: ${count}`);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required to clean smoke data.");
    process.exitCode = 2;
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const before = await collectSmokeCounts(prisma);
    const threadIds = await collectDeerFlowThreadIds(prisma);
    const gateway = options.dryRun ? [] : await deleteGatewayThreads(threadIds, options);
    const deleted = options.dryRun ? [] : await deleteSmokeData(prisma);
    const after = options.dryRun ? {} : await collectSmokeCounts(prisma);
    const summary = { dryRun: options.dryRun, before, gateway, deleted, after };
    printSummary(summary, options.json);

    const gatewayFailed = gateway.some((item) => !item.ok);
    const afterDirty = !options.dryRun && Object.values(after).some((count) => count !== 0);
    if (gatewayFailed || afterDirty) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

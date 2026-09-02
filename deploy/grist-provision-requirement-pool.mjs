#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import pg from "pg";

import {
  requirementPoolDocumentName,
  requirementPoolLegacyDocumentNames,
  requirementPoolTable,
  requirementPoolViewName,
  requirementPoolWorkspaceName,
} from "./grist-requirement-pool-schema.mjs";

const deployDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(deployDir, "..");
const gristDataDir = process.env.GRIST_LOCAL_DATA_DIR?.trim()
  ? resolve(process.env.GRIST_LOCAL_DATA_DIR)
  : resolve(rootDir, "storage/grist");
const homeDatabase = resolve(gristDataDir, "persist/home.sqlite3");
const localScript = resolve(deployDir, "grist-local.sh");
const controlScript = process.env.GRIST_CONTROL_SCRIPT?.trim()
  ? resolve(process.env.GRIST_CONTROL_SCRIPT)
  : localScript;
const databaseUrl = process.env.WORKBENCH_DATABASE_URL?.trim()
  || "postgresql://localhost/ai_product_workbench";
const gristOrigin = process.env.GRIST_LOCAL_URL?.trim() || "http://localhost:8484";

const selectedOwnerEmail = process.env.GRIST_OWNER_EMAIL?.trim();
const selectedOwnerName = process.env.GRIST_OWNER_NAME?.trim();
const owner = selectedOwnerEmail && selectedOwnerName
  ? explicitOwner(selectedOwnerEmail, selectedOwnerName)
  : await getWorkbenchOwner(databaseUrl, selectedOwnerEmail);
runLocal("stop");

const apiKey = randomBytes(24).toString("base64url");
let account;
try {
  mkdirSync(resolve(gristDataDir, "backups"), { recursive: true });
  var backupPath = resolve(
    gristDataDir,
    "backups",
    `home-before-requirement-pool-${new Date().toISOString().replaceAll(":", "-")}.sqlite3`,
  );
  copyFileSync(homeDatabase, backupPath);

  const home = new DatabaseSync(homeDatabase);
  home.exec("PRAGMA foreign_keys = ON");
  home.exec("BEGIN IMMEDIATE");
  try {
    account = adoptWorkbenchOwner(home, owner, apiKey);
    home.exec("COMMIT");
  } catch (error) {
    home.exec("ROLLBACK");
    throw error;
  } finally {
    home.close();
  }
} finally {
  runLocal("start");
}

let documentId = account.documentId;
if (!documentId) {
  const created = await gristRequest(`/api/workspaces/${account.workspaceId}/docs`, {
    method: "POST",
    apiKey,
    body: { name: requirementPoolDocumentName },
  });
  documentId = typeof created === "string" ? created : created?.id;
  if (!documentId) throw new Error("Grist did not return a document id");
}

const tablesResponse = await gristRequest(`/api/docs/${documentId}/tables`, { apiKey });
const tableIds = new Set((tablesResponse.tables ?? []).map((table) => table.id));
if (!tableIds.has(requirementPoolTable.id)) {
  await gristRequest(`/api/docs/${documentId}/tables`, {
    method: "POST",
    apiKey,
    body: { tables: [requirementPoolTable] },
  });
  tableIds.add(requirementPoolTable.id);
}
if (tableIds.has("Table1") && tableIds.has(requirementPoolTable.id)) {
  await gristRequest(`/api/docs/${documentId}/apply`, {
    method: "POST",
    apiKey,
    body: [["RemoveTable", "Table1"]],
  });
}
const finalTablesResponse = await gristRequest(`/api/docs/${documentId}/tables`, { apiKey });
const requirementTable = (finalTablesResponse.tables ?? [])
  .find((table) => table.id === requirementPoolTable.id);
if (!requirementTable?.fields?.primaryViewId) {
  throw new Error("Grist did not return the requirement pool primary view");
}
await gristRequest(`/api/docs/${documentId}/tables/_grist_Views/records`, {
  method: "PATCH",
  apiKey,
  body: {
    records: [{
      id: requirementTable.fields.primaryViewId,
      fields: { name: requirementPoolViewName },
    }],
  },
});

const documentPath = `/o/docs/doc/${documentId}`;
const signInUrl = new URL("/auth/login", gristOrigin);
signInUrl.searchParams.set("next", documentPath);
const manifest = {
  documentId,
  documentName: requirementPoolDocumentName,
  ownerEmail: owner.email,
  tableId: requirementPoolTable.id,
  viewName: requirementPoolViewName,
  workspaceName: requirementPoolWorkspaceName,
  url: `${gristOrigin}${documentPath}`,
  signInUrl: signInUrl.href,
  provisionedAt: new Date().toISOString(),
};
writeFileSync(
  resolve(gristDataDir, "requirement-pool.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`Requirement pool is ready: ${manifest.signInUrl}`);
console.log(`Owner: ${owner.email}`);
console.log(`Metadata backup: ${backupPath}`);

async function getWorkbenchOwner(connectionString, selectedEmail) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query(`
      SELECT email, name, display_username
      FROM workbench.auth_users
      WHERE ($1::text IS NULL OR lower(email) = lower($1))
      ORDER BY created_at
    `, [selectedEmail || null]);
    if (result.rows.length !== 1) {
      const hint = selectedEmail
        ? `No unique Workbench account matched ${selectedEmail}`
        : "Set GRIST_OWNER_EMAIL when Workbench has more than one account";
      throw new Error(`${hint}; matched ${result.rows.length} accounts`);
    }
    const row = result.rows[0];
    return {
      email: row.email.toLowerCase(),
      name: row.display_username?.trim() || row.name?.trim() || row.email.split("@")[0],
    };
  } finally {
    await pool.end();
  }
}

function explicitOwner(email, name) {
  const normalizedEmail = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail)) {
    throw new Error("GRIST_OWNER_EMAIL must be a valid email address");
  }
  if (!name || name.length > 255) {
    throw new Error("GRIST_OWNER_NAME must contain 1 to 255 characters");
  }
  return { email: normalizedEmail, name };
}

function adoptWorkbenchOwner(database, owner, apiKeyValue) {
  const loginByEmail = database.prepare(`
    SELECT users.id AS user_id
    FROM logins JOIN users ON users.id = logins.user_id
    WHERE lower(logins.email) = lower(?)
  `).get(owner.email);
  const placeholder = database.prepare(`
    SELECT users.id AS user_id
    FROM logins
    JOIN users ON users.id = logins.user_id
    JOIN orgs ON orgs.owner_id = users.id
    WHERE orgs.name = 'Personal'
    ORDER BY orgs.id
    LIMIT 1
  `).get();

  let userId = loginByEmail?.user_id;
  if (!userId) {
    if (!placeholder?.user_id) {
      throw new Error("Neither the Workbench owner nor the initial Grist owner exists");
    }
    userId = placeholder.user_id;
    database.prepare(
      "UPDATE logins SET email = ?, display_email = ? WHERE user_id = ?",
    ).run(owner.email, owner.email, userId);
  }
  const storedOptions = database.prepare("SELECT options FROM users WHERE id = ?")
    .get(userId)?.options;
  const options = storedOptions ? JSON.parse(storedOptions) : {};
  options.locale = "zh-Hans";
  database.prepare("UPDATE users SET name = ?, api_key = ?, options = ? WHERE id = ?")
    .run(owner.name, apiKeyValue, JSON.stringify(options), userId);

  const workspace = database.prepare(`
    SELECT workspaces.id
    FROM workspaces JOIN orgs ON orgs.id = workspaces.org_id
    WHERE orgs.owner_id = ?
    ORDER BY workspaces.id
    LIMIT 1
  `).get(userId);
  if (!workspace?.id) throw new Error("The Grist owner has no personal workspace");
  database.prepare("UPDATE workspaces SET name = ? WHERE id = ?")
    .run(requirementPoolWorkspaceName, workspace.id);

  const knownDocumentNames = new Set([
    requirementPoolDocumentName,
    ...requirementPoolLegacyDocumentNames,
  ]);
  const documents = database.prepare(`
    SELECT id, name FROM docs
    WHERE workspace_id = ? AND removed_at IS NULL
    ORDER BY created_at
  `).all(workspace.id);
  const document = documents.find((item) => item.name === requirementPoolDocumentName)
    ?? documents.find((item) => knownDocumentNames.has(item.name));
  if (document && document.name !== requirementPoolDocumentName) {
    database.prepare("UPDATE docs SET name = ? WHERE id = ?")
      .run(requirementPoolDocumentName, document.id);
  }
  return { userId, workspaceId: workspace.id, documentId: document?.id ?? null };
}

async function gristRequest(path, { method = "GET", body, apiKey: token }) {
  const response = await fetch(new URL(path, gristOrigin), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Grist ${method} ${path} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function runLocal(command) {
  execFileSync(controlScript, [command], { cwd: rootDir, stdio: "inherit" });
}

#!/usr/bin/env node
import bcrypt from "bcryptjs";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";
import { collectSmokeCounts, deleteSmokeData } from "./cleanup-smoke-data.mjs";

const apiBaseUrl = (process.env.API_BASE_URL ?? "http://localhost:4000/api").replace(/\/$/, "");
const runId = `${Date.now()}`;
const adminPassword = `AdminSmoke-${runId}!`;
const userPassword = `UserSmoke-${runId}!`;
const resetPassword = `ResetSmoke-${runId}!`;
const adminUsername = `codex_local_smoke_admin_${runId}`;
const userUsername = `codex_local_smoke_user_${runId}`;
const providerName = `codex_local_smoke_provider_${runId}`;
const modelDisplayName = `codex_local_smoke_model_${runId}`;
const adminEmail = `${adminUsername}@example.test`;
const userEmail = `${userUsername}@example.test`;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for admin write smoke.");
  process.exit(2);
}

const prisma = new PrismaClient();

try {
  await deleteSmokeData(prisma);
  await prisma.user.create({
    data: {
      username: adminUsername,
      email: adminEmail,
      displayName: "Codex Local Smoke Admin",
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: UserRole.admin,
      status: UserStatus.active,
    },
  });

  const adminSession = await login(adminEmail, adminPassword);
  assert(adminSession.user.role === UserRole.admin, "Admin login did not return admin role.");

  const createdUser = await requestJson("/admin/users", {
    method: "POST",
    cookie: adminSession.cookie,
    body: {
      username: userUsername,
      displayName: "Codex Local Smoke User",
      email: userEmail,
      password: userPassword,
      role: UserRole.user,
      status: UserStatus.active,
    },
  });
  assert(createdUser.username === userUsername, "Admin create user returned the wrong username.");

  const listedUsers = await requestJson(`/admin/users?keyword=${encodeURIComponent(userUsername)}`, {
    cookie: adminSession.cookie,
  });
  assert(listedUsers.total === 1, "Admin list users did not find the created smoke user.");

  await requestJson(`/admin/users/${createdUser.id}/disable`, {
    method: "POST",
    cookie: adminSession.cookie,
  });
  await expectLoginStatus(userEmail, userPassword, 403);

  await requestJson(`/admin/users/${createdUser.id}/enable`, {
    method: "POST",
    cookie: adminSession.cookie,
  });
  await requestJson(`/admin/users/${createdUser.id}/reset-password`, {
    method: "POST",
    cookie: adminSession.cookie,
    body: { password: resetPassword },
  });

  const userSession = await login(userEmail, resetPassword);
  assert(userSession.user.username === userUsername, "Reset password login returned the wrong user.");

  const provider = await requestJson("/admin/model-providers", {
    method: "POST",
    cookie: adminSession.cookie,
    body: {
      name: providerName,
      baseUrl: "https://example.invalid/v1",
      apiKey: `smoke-key-${runId}`,
      timeoutMs: 1000,
      isDefault: false,
    },
  });
  assert(provider.name === providerName, "Admin create model provider returned the wrong name.");

  const updatedProvider = await requestJson(`/admin/model-providers/${provider.id}`, {
    method: "PATCH",
    cookie: adminSession.cookie,
    body: {
      name: `${providerName}_updated`,
      apiKey: `smoke-key-updated-${runId}`,
    },
  });
  assert(updatedProvider.name === `${providerName}_updated`, "Admin update model provider did not persist.");

  await requestJson(`/admin/model-providers/${provider.id}/disable`, {
    method: "POST",
    cookie: adminSession.cookie,
  });
  await requestJson(`/admin/model-providers/${provider.id}/enable`, {
    method: "POST",
    cookie: adminSession.cookie,
  });

  const modelConfig = await requestJson("/admin/model-configs", {
    method: "POST",
    cookie: adminSession.cookie,
    body: {
      providerId: provider.id,
      displayName: modelDisplayName,
      modelName: `smoke-model-${runId}`,
      supportsStreaming: true,
      supportsJsonMode: false,
      supportsMultimodal: false,
      defaultTemperature: 0.1,
      defaultMaxTokens: 256,
    },
  });
  assert(modelConfig.displayName === modelDisplayName, "Admin create model config returned the wrong display name.");

  const disabledConfig = await requestJson(`/admin/model-configs/${modelConfig.id}`, {
    method: "PATCH",
    cookie: adminSession.cookie,
    body: { isEnabled: false },
  });
  assert(disabledConfig.isEnabled === false, "Admin disable model config did not persist.");

  const auditCount = await prisma.adminAuditLog.count({
    where: { adminUser: { username: adminUsername } },
  });
  assert(auditCount >= 10, "Admin write smoke did not create the expected audit trail.");
} finally {
  await deleteSmokeData(prisma);
  const after = await collectSmokeCounts(prisma);
  await prisma.$disconnect();
  const dirty = Object.entries(after).filter(([, count]) => Number(count) !== 0);
  if (dirty.length > 0) {
    console.error(JSON.stringify({ after }, null, 2));
    throw new Error("Smoke data cleanup left residue.");
  }
}

console.log("Admin write smoke passed and left no smoke data residue.");

async function login(account, password) {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account, password }),
  });
  const payload = await parseJson(response);
  assert(response.status === 201, `Login ${account} expected 201, got ${response.status}: ${JSON.stringify(payload)}`);
  const cookie = readCookie(response);
  assert(cookie, "Login response did not include auth cookie.");
  return { user: payload.user, cookie };
}

async function expectLoginStatus(account, password, expectedStatus) {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account, password }),
  });
  await parseJson(response);
  assert(response.status === expectedStatus, `Login ${account} expected ${expectedStatus}, got ${response.status}.`);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await parseJson(response);
  assert(response.ok, `${options.method ?? "GET"} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function readCookie(response) {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.at(0)?.split(";")[0] ?? "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

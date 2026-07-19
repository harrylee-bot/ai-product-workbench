#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const csrfToken = randomBytes(64).toString("base64url");

const defaults = {
  gatewayUrl: process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001",
  langgraphUrl: process.env.DEERFLOW_LANGGRAPH_URL ?? `${process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001"}/api`,
  agentDir: path.join(repoRoot, "integrations/deerflow/agents/workbench-lead"),
  skillDir: path.join(repoRoot, "integrations/deerflow/skills/workbench"),
  threadId: process.env.DEERFLOW_BOOTSTRAP_THREAD_ID,
  adminAccessToken: process.env.DEERFLOW_ADMIN_ACCESS_TOKEN,
};

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const config = {
  gatewayUrl: normalizeBaseUrl(options.gatewayUrl ?? defaults.gatewayUrl),
  langgraphUrl: normalizeBaseUrl(options.langgraphUrl ?? defaults.langgraphUrl),
  agentDir: path.resolve(options.agentDir ?? defaults.agentDir),
  skillDir: path.resolve(options.skillDir ?? defaults.skillDir),
  threadId: options.threadId ?? defaults.threadId,
  adminAccessToken: defaults.adminAccessToken,
  dryRun: Boolean(options.dryRun),
  skipAgent: Boolean(options.skipAgent),
  skipSkill: Boolean(options.skipSkill),
  keepArchive: Boolean(options.keepArchive),
};

await main(config);

async function main(config) {
  assertPath(config.agentDir, "agent directory");
  assertPath(config.skillDir, "skill directory");

  const writesRequested = !config.skipAgent || !config.skipSkill;
  const adminHeaders = !config.dryRun && writesRequested
    ? createAdminAuthHeaders(config.adminAccessToken)
    : null;

  const agent = await loadAgent(config.agentDir);
  const skillName = await readSkillName(config.skillDir);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "workbench-deerflow-"));
  const archivePath = path.join(tempDir, `${skillName}.skill`);

  try {
    packageSkill(config.skillDir, archivePath);
    log(`Packaged skill: ${archivePath}`);

    if (config.dryRun) {
      if (!config.skipAgent) {
        log(`Dry run: would upsert agent '${agent.name}' at ${config.gatewayUrl}/api/agents`);
      }
      if (!config.skipSkill) {
        log(`Dry run: would install or refresh skill '${skillName}' through ${config.gatewayUrl}/api/skills/install`);
      }
      return;
    }

    if (!config.skipAgent) {
      await upsertAgent(config.gatewayUrl, agent, adminHeaders);
      log(`Admin-scoped custom agent installed or updated: ${agent.name}`);
    }

    if (!config.skipSkill) {
      const threadId = config.threadId ?? await createThread(config.langgraphUrl, adminHeaders);
      log(`Bootstrap thread: ${threadId}`);
      const virtualPath = await uploadSkillArchive(config.gatewayUrl, threadId, archivePath, adminHeaders);
      await installSkill(config.gatewayUrl, threadId, virtualPath, skillName, adminHeaders);
      await enableSkill(config.gatewayUrl, skillName, adminHeaders);
      log(`Admin-scoped custom skill installed and enabled: ${skillName}`);
      log("Production runtime readiness still requires the skill to ship as a read-only PUBLIC skill in the DeerFlow deployment.");
    }
  } finally {
    if (!config.keepArchive) {
      await rm(tempDir, { recursive: true, force: true });
    } else {
      log(`Kept archive directory: ${tempDir}`);
    }
  }
}

async function loadAgent(agentDir) {
  const configPath = path.join(agentDir, "agent.json");
  const soulPath = path.join(agentDir, "SOUL.md");
  assertPath(configPath, "agent config");
  assertPath(soulPath, "agent SOUL.md");
  const agent = JSON.parse(await readFile(configPath, "utf8"));
  agent.soul = await readFile(soulPath, "utf8");
  if (!agent.name || !/^[A-Za-z0-9-]+$/.test(agent.name)) {
    throw new Error(`Invalid agent name: ${agent.name}`);
  }
  return agent;
}

async function readSkillName(skillDir) {
  const skillPath = path.join(skillDir, "SKILL.md");
  assertPath(skillPath, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const name = match?.[1].match(/^name:\s*([A-Za-z0-9-]+)\s*$/m)?.[1];
  if (!name) throw new Error(`Missing skill frontmatter name in ${skillPath}`);
  return name;
}

function packageSkill(skillDir, archivePath) {
  const result = spawnSync("zip", ["-qr", archivePath, "."], {
    cwd: skillDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to package skill: ${result.stderr || result.stdout || "zip failed"}`);
  }
}

async function upsertAgent(gatewayUrl, agent, adminHeaders) {
  const body = {
    name: agent.name,
    description: agent.description ?? "",
    model: agent.model ?? null,
    tool_groups: agent.tool_groups ?? null,
    soul: agent.soul,
  };

  const put = await fetchJson(`${gatewayUrl}/api/agents/${encodeURIComponent(agent.name)}`, {
    method: "PUT",
    headers: jsonHeaders(adminHeaders),
    body: JSON.stringify({
      description: body.description,
      model: body.model,
      tool_groups: body.tool_groups,
      soul: body.soul,
    }),
  }, [404]);

  if (put.response.status !== 404) return put.data;

  return (await fetchJson(`${gatewayUrl}/api/agents`, {
    method: "POST",
    headers: jsonHeaders(adminHeaders),
    body: JSON.stringify(body),
  })).data;
}

async function createThread(langgraphUrl, adminHeaders) {
  const result = await fetchJson(`${langgraphUrl}/threads`, {
    method: "POST",
    headers: jsonHeaders(adminHeaders),
    body: JSON.stringify({
      metadata: {
        source: "workbench-bootstrap",
      },
    }),
  });
  const threadId = result.data?.thread_id ?? result.data?.threadId;
  if (!threadId) throw new Error("LangGraph thread create response did not include thread_id");
  return threadId;
}

async function uploadSkillArchive(gatewayUrl, threadId, archivePath, adminHeaders) {
  const buffer = await readFile(archivePath);
  const formData = new FormData();
  formData.append("files", new Blob([new Uint8Array(buffer)], { type: "application/zip" }), path.basename(archivePath));
  const result = await fetchJson(`${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads`, {
    method: "POST",
    headers: adminHeaders,
    body: formData,
  });
  const first = Array.isArray(result.data?.files) ? result.data.files[0] : null;
  const virtualPath = first?.virtual_path ?? first?.virtualPath;
  if (!virtualPath) throw new Error("Gateway upload response did not include virtual_path");
  return virtualPath;
}

async function installSkill(gatewayUrl, threadId, virtualPath, skillName, adminHeaders) {
  const request = {
    method: "POST",
    headers: jsonHeaders(adminHeaders),
    body: JSON.stringify({
      thread_id: threadId,
      path: virtualPath,
    }),
  };
  const result = await fetchJson(`${gatewayUrl}/api/skills/install`, request, [409]);

  if (result.response.status === 409) {
    log(`Skill already installed: ${skillName}; reinstalling to refresh files`);
    await deleteCustomSkill(gatewayUrl, skillName, adminHeaders);
    return (await fetchJson(`${gatewayUrl}/api/skills/install`, request)).data;
  }
  return result.data;
}

async function deleteCustomSkill(gatewayUrl, skillName, adminHeaders) {
  const result = await fetchJson(`${gatewayUrl}/api/skills/custom/${encodeURIComponent(skillName)}`, {
    method: "DELETE",
    headers: jsonHeaders(adminHeaders),
  }, [404]);

  if (result.response.status === 404) {
    log(`Custom skill not found before reinstall: ${skillName}`);
  }
  return result.data;
}

async function enableSkill(gatewayUrl, skillName, adminHeaders) {
  return (await fetchJson(`${gatewayUrl}/api/skills/${encodeURIComponent(skillName)}`, {
    method: "PUT",
    headers: jsonHeaders(adminHeaders),
    body: JSON.stringify({ enabled: true }),
  })).data;
}

async function fetchJson(url, init, allowStatuses = []) {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? parseJson(text) : null;
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const detail = data?.detail ?? text;
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${response.status} ${detail}`);
  }
  return { response, data };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--skip-agent") parsed.skipAgent = true;
    else if (arg === "--skip-skill") parsed.skipSkill = true;
    else if (arg === "--keep-archive") parsed.keepArchive = true;
    else if (arg === "--gateway-url") parsed.gatewayUrl = argv[++index];
    else if (arg === "--langgraph-url") parsed.langgraphUrl = argv[++index];
    else if (arg === "--agent-dir") parsed.agentDir = argv[++index];
    else if (arg === "--skill-dir") parsed.skillDir = argv[++index];
    else if (arg === "--thread-id") parsed.threadId = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function jsonHeaders(authHeaders) {
  return {
    ...authHeaders,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function createAdminAuthHeaders(rawToken) {
  const token = rawToken?.trim();
  if (!token) {
    throw new Error(
      "DEERFLOW_ADMIN_ACCESS_TOKEN is required for DeerFlow bootstrap writes; "
      + "DEERFLOW_INTERNAL_AUTH_TOKEN is a runtime service credential and cannot authorize skill management.",
    );
  }
  if (/\s|[;,]/.test(token) || /^Bearer\s/i.test(token)) {
    throw new Error("DEERFLOW_ADMIN_ACCESS_TOKEN must contain the raw admin session token without whitespace, cookie delimiters, or a 'Bearer ' prefix.");
  }
  return Object.freeze({
    "X-CSRF-Token": csrfToken,
    Cookie: `access_token=${token}; csrf_token=${csrfToken}`,
  });
}

function assertPath(targetPath, label) {
  if (!existsSync(targetPath)) throw new Error(`Missing ${label}: ${targetPath}`);
}

function log(message) {
  console.log(`[deerflow-bootstrap] ${message}`);
}

function printHelp() {
  console.log(`Usage: npm run deerflow:bootstrap -- [options]

Options:
  --dry-run                 Package and validate assets without network calls
  --gateway-url <url>       DeerFlow Gateway URL, default DEERFLOW_GATEWAY_URL or http://localhost:8001
  --langgraph-url <url>     DeerFlow LangGraph-compatible URL, default DEERFLOW_LANGGRAPH_URL or DEERFLOW_GATEWAY_URL/api
  --thread-id <id>          Existing DeerFlow thread used to upload the .skill archive
  --skip-agent              Do not create/update the custom agent
  --skip-skill              Do not install/enable the skill
  --keep-archive            Keep the temporary packaged .skill archive
  --help                    Show this help

Environment:
  DEERFLOW_ADMIN_ACCESS_TOKEN  Raw session access token for a real DeerFlow admin user. All
                              agent/thread/upload/skill writes use this same access_token cookie.
                              DEERFLOW_INTERNAL_AUTH_TOKEN is not accepted as an admin credential.

Scope:
  DeerFlow custom agents and skills are per-user. This command validates and installs them only
  for the authenticated admin identity. Production must ship 'workbench' as a read-only PUBLIC
  skill with the DeerFlow deployment; this command does not create a shared or runtime-wide skill.
`);
}

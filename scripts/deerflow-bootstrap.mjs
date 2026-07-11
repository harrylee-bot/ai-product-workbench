#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const defaults = {
  gatewayUrl: process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001",
  langgraphUrl: process.env.DEERFLOW_LANGGRAPH_URL ?? `${process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001"}/api`,
  agentDir: path.join(repoRoot, "integrations/deerflow/agents/ai-product-workbench-lead"),
  skillDir: path.join(repoRoot, "integrations/deerflow/skills/ai-product-workbench"),
  threadId: process.env.DEERFLOW_BOOTSTRAP_THREAD_ID,
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
  dryRun: Boolean(options.dryRun),
  skipAgent: Boolean(options.skipAgent),
  skipSkill: Boolean(options.skipSkill),
  keepArchive: Boolean(options.keepArchive),
};

await main(config);

async function main(config) {
  assertPath(config.agentDir, "agent directory");
  assertPath(config.skillDir, "skill directory");

  const agent = await loadAgent(config.agentDir);
  const skillName = await readSkillName(config.skillDir);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-workbench-deerflow-"));
  const archivePath = path.join(tempDir, `${skillName}.skill`);

  try {
    packageSkill(config.skillDir, archivePath);
    log(`Packaged skill: ${archivePath}`);

    if (config.dryRun) {
      log(`Dry run: would upsert agent '${agent.name}' at ${config.gatewayUrl}/api/agents`);
      log(`Dry run: would install or refresh skill '${skillName}' through ${config.gatewayUrl}/api/skills/install`);
      return;
    }

    if (!config.skipAgent) {
      await upsertAgent(config.gatewayUrl, agent);
      log(`Agent ready: ${agent.name}`);
    }

    if (!config.skipSkill) {
      const threadId = config.threadId ?? await createThread(config.langgraphUrl);
      log(`Bootstrap thread: ${threadId}`);
      const virtualPath = await uploadSkillArchive(config.gatewayUrl, threadId, archivePath);
      await installSkill(config.gatewayUrl, threadId, virtualPath, skillName);
      await enableSkill(config.gatewayUrl, skillName);
      log(`Skill ready: ${skillName}`);
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

async function upsertAgent(gatewayUrl, agent) {
  const body = {
    name: agent.name,
    description: agent.description ?? "",
    model: agent.model ?? null,
    tool_groups: agent.tool_groups ?? null,
    soul: agent.soul,
  };

  const put = await fetchJson(`${gatewayUrl}/api/agents/${encodeURIComponent(agent.name)}`, {
    method: "PUT",
    headers: jsonHeaders(),
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
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  })).data;
}

async function createThread(langgraphUrl) {
  const result = await fetchJson(`${langgraphUrl}/threads`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      metadata: {
        source: "ai-product-workbench-bootstrap",
      },
    }),
  });
  const threadId = result.data?.thread_id ?? result.data?.threadId;
  if (!threadId) throw new Error("LangGraph thread create response did not include thread_id");
  return threadId;
}

async function uploadSkillArchive(gatewayUrl, threadId, archivePath) {
  const buffer = await readFile(archivePath);
  const formData = new FormData();
  formData.append("files", new Blob([new Uint8Array(buffer)], { type: "application/zip" }), path.basename(archivePath));
  const result = await fetchJson(`${gatewayUrl}/api/threads/${encodeURIComponent(threadId)}/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  const first = Array.isArray(result.data?.files) ? result.data.files[0] : null;
  const virtualPath = first?.virtual_path ?? first?.virtualPath;
  if (!virtualPath) throw new Error("Gateway upload response did not include virtual_path");
  return virtualPath;
}

async function installSkill(gatewayUrl, threadId, virtualPath, skillName) {
  const request = {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      thread_id: threadId,
      path: virtualPath,
    }),
  };
  const result = await fetchJson(`${gatewayUrl}/api/skills/install`, request, [409]);

  if (result.response.status === 409) {
    log(`Skill already installed: ${skillName}; reinstalling to refresh files`);
    await deleteCustomSkill(gatewayUrl, skillName);
    return (await fetchJson(`${gatewayUrl}/api/skills/install`, request)).data;
  }
  return result.data;
}

async function deleteCustomSkill(gatewayUrl, skillName) {
  const result = await fetchJson(`${gatewayUrl}/api/skills/custom/${encodeURIComponent(skillName)}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  }, [404]);

  if (result.response.status === 404) {
    log(`Custom skill not found before reinstall: ${skillName}`);
  }
  return result.data;
}

async function enableSkill(gatewayUrl, skillName) {
  return (await fetchJson(`${gatewayUrl}/api/skills/${encodeURIComponent(skillName)}`, {
    method: "PUT",
    headers: jsonHeaders(),
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

function jsonHeaders() {
  return {
    ...authHeaders(),
    "content-type": "application/json",
    accept: "application/json",
  };
}

function authHeaders() {
  const token = process.env.DEERFLOW_INTERNAL_AUTH_TOKEN?.trim()
    || process.env.DEER_FLOW_INTERNAL_AUTH_TOKEN?.trim();
  return token ? { "X-DeerFlow-Internal-Token": token } : {};
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
`);
}

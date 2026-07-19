#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import YAML from "yaml";

import {
  WORKBENCH_CANVAS_TOOLS,
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_SKILL_ALLOWED_TOOLS,
  WORKBENCH_TOOL_GROUP,
} from "./deerflow-workbench-tool-contract.mjs";

const root = new URL("../", import.meta.url);
const runtimeCompose = readYaml("deploy/deerflow-runtime-compose.yml");
const extensions = JSON.parse(readText("deploy/deerflow-extensions.production.json"));
const fragment = readYaml("integrations/deerflow/runtime-tools/config.fragment.yaml");
const workbenchSkill = readYamlFrontmatter("integrations/deerflow/skills/workbench/SKILL.md");
const envExample = readText("deploy/workbench.env.example");
const runtimeAdapter = readText("apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts");
const preflight = readText("deploy/deerflow-production-preflight.sh");
const gateway = runtimeCompose.services?.deerflow;
const patchCommit = "7a6c4a994a86583d2a3c056ee9d0f157d4f030c2";
const patchRoot = `integrations/deerflow/source-patches/${patchCommit}`;
const patchManifestSource = readText(`${patchRoot}/manifest.json`);
const patchManifest = JSON.parse(patchManifestSource);
const toolScopeMiddlewareSource = readText(`${patchRoot}/workbench_tool_scope_middleware.py`);
const patchApplierSource = readText(`${patchRoot}/apply.py`);
const patchContractTestSource = readText(`${patchRoot}/test_workbench_tool_scope_middleware.py`);
const patchManifestSha256 = sha256(patchManifestSource);
const expectedCommit = argumentValue("--expected-commit");

assert(gateway, "production runtime Compose must define deerflow");
assert(
  gateway.image === "${WORKBENCH_DEERFLOW_IMAGE_REF:?WORKBENCH_DEERFLOW_IMAGE_REF must be an immutable OCI digest reference}",
  "DeerFlow must be supplied only through the pinned image reference",
);
assertDeepEqual(gateway.ports, ["127.0.0.1:${WORKBENCH_DEERFLOW_HOST_PORT:-2026}:8001"], "DeerFlow must publish only one loopback port");

const requiredEnvironment = {
  DEER_FLOW_ENV: "production",
  ENVIRONMENT: "production",
  DEER_FLOW_AUTH_DISABLED: "0",
  DEER_FLOW_PROJECT_ROOT: "/app",
  DEER_FLOW_HOME: "/app/backend/.deer-flow",
  DEER_FLOW_CONFIG_PATH: "/app/backend/config.yaml",
  DEER_FLOW_EXTENSIONS_CONFIG_PATH: "/app/backend/extensions_config.workbench.json",
  DEER_FLOW_SKILLS_PATH: "/app/skills",
  DEER_FLOW_INTERNAL_AUTH_TOKEN: "${WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN:?WORKBENCH_DEERFLOW_INTERNAL_AUTH_TOKEN is required}",
  PYTHONDONTWRITEBYTECODE: "1",
};
for (const [name, expected] of Object.entries(requiredEnvironment)) {
  assert(gateway.environment?.[name] === expected, `${name} must be fixed by the production overlay`);
}

const requiredVolumes = [
  "${DEER_FLOW_CONFIG_PATH:?DEER_FLOW_CONFIG_PATH must point to the generated effective config}:/app/backend/config.yaml:ro",
  "${DEER_FLOW_HOME:?DEER_FLOW_HOME must be a dedicated runtime home}:/app/backend/.deer-flow",
];
assertDeepEqual(gateway.volumes, requiredVolumes, "gateway mounts must match the audited production contract");
assert(!gateway.volumes.some((mount) => mount.includes("/app/skills/custom")), "custom skill storage must not be mounted");
assert(!gateway.volumes.some((mount) => mount.includes("DEER_FLOW_REPO_ROOT")), "production runtime must not depend on a host source checkout");
assert(!gateway.volumes.some((mount) => mount.includes("integrations/deerflow")), "production extensions must be embedded in the derived image");
assert(gateway.pull_policy === "never", "preflight must resolve the image before Compose starts it");
assert(gateway.read_only === true, "the derived DeerFlow root filesystem must be read-only");
for (const variable of [
  "WORKBENCH_DEERFLOW_BASE_IMAGE_REF=",
  "WORKBENCH_DEERFLOW_IMAGE_REF=",
  "WORKBENCH_DEERFLOW_IMAGE_DIGEST=",
  "WORKBENCH_SOURCE_COMMIT=",
  "WORKBENCH_COSIGN_CERTIFICATE_IDENTITY=",
  "WORKBENCH_COSIGN_OIDC_ISSUER=",
]) {
  assert(envExample.includes(variable), `deployment env example is missing ${variable}`);
}
assert(
  envExample.includes(`WORKBENCH_DEERFLOW_COMMIT=${patchCommit}`),
  "deployment env example must pin the audited DeerFlow source commit",
);

const mountTargets = gateway.volumes.map((mount) => mount.slice(mount.lastIndexOf(":/app/") + 1).replace(/:ro$/u, ""));
assert(new Set(mountTargets).size === mountTargets.length, "gateway mount targets must be unique");
assertDeepEqual(gateway.networks?.["workbench-runtime"]?.aliases, ["deerflow"], "gateway must expose the stable internal alias deerflow");
assert(gateway.networks?.["deerflow-egress"], "gateway must have only the explicit provider egress path");
assert(runtimeCompose.networks?.["workbench-runtime"]?.external === true, "Workbench runtime network must be external");
assert(
  runtimeCompose.networks?.["workbench-runtime"]?.name === "${WORKBENCH_INTERNAL_NETWORK_NAME:?WORKBENCH_INTERNAL_NETWORK_NAME is required}",
  "Workbench runtime network name must be explicit",
);
assert(gateway.cap_drop?.includes("ALL"), "DeerFlow must drop ambient Linux capabilities");
assert(gateway.security_opt?.includes("no-new-privileges:true"), "DeerFlow must forbid privilege escalation");
assert(String(gateway.command).includes("--workers 1"), "DeerFlow must keep a single in-process runtime worker");

const deerflowDockerfile = readText("integrations/deerflow/Dockerfile");
for (const requiredLine of [
  "ARG DEERFLOW_BASE_IMAGE",
  "FROM ${DEERFLOW_BASE_IMAGE} AS runtime",
  "io.workbench.deerflow.base-image",
  "io.workbench.deerflow.source-commit",
  "COPY integrations/deerflow/skills/workbench/ /app/skills/public/workbench/",
  "COPY integrations/deerflow/runtime-tools/deerflow_workbench_tools/ /app/backend/deerflow_workbench_tools/",
  `COPY integrations/deerflow/source-patches/${patchCommit}/ /opt/workbench/deerflow/source-patch/`,
  `test \"\${DEERFLOW_SOURCE_COMMIT}\" = \"${patchCommit}\"`,
  "test_workbench_tool_scope_middleware.py",
  "apply.py",
  "--check",
  `ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=${patchManifestSha256}`,
  "io.workbench.deerflow.tool-scope-patch-sha256",
]) {
  assert(deerflowDockerfile.includes(requiredLine), `derived DeerFlow Dockerfile is missing: ${requiredLine}`);
}

assert(patchManifest.protocol === "workbench.deerflow-source-patch.v1", "DeerFlow source patch manifest protocol is invalid");
assert(
  patchManifest.upstreamRepository === "https://github.com/bytedance/deer-flow",
  "DeerFlow source patch must bind the canonical upstream repository",
);
assert(patchManifest.upstreamCommit === patchCommit, "DeerFlow source patch must bind the audited upstream commit");
if (expectedCommit !== undefined) {
  assert(expectedCommit === patchCommit, "deployment expected commit must match the audited DeerFlow patch commit");
}
assert(
  patchManifest.agent?.upstreamSha256 === "9052cfadca31817a927e83ad2dff01bfe5afdf5acdae337cc8f30eb1a8d8469f",
  "DeerFlow lead-agent upstream source hash drifted",
);
assert(
  patchManifest.agent?.patchedSha256 === "363a91528113a6daba6441dc7c2a32c787c8478a12be93f3222ba38adb7c8454",
  "DeerFlow lead-agent patched source hash drifted",
);
assert(
  patchManifest.deferredMiddleware?.sha256 === "d0fb92b78bf7d65a3444925a7cef4a1072f464127b75393fdaf5f1fb7d9053f2",
  "DeerFlow middleware API source hash drifted",
);
assertDeepEqual(patchManifest.additionalSources, [], "DeerFlow source patch may modify only the audited lead agent and add the scoped middleware");
assert(
  patchManifest.agent?.insertion?.includes(
    "WorkbenchToolScopeMiddleware(workbench_canvas_policy_from_runnable_config(config))",
  ),
  "DeerFlow lead-agent patch must freeze the per-Run configurable policy into the middleware",
);
assert(
  sha256(toolScopeMiddlewareSource)
    === patchManifest.toolScopeMiddleware?.sha256,
  "Workbench tool-scope middleware does not match its manifest",
);
assert(
  toolScopeMiddlewareSource.includes("def workbench_canvas_policy_from_runnable_config(config: Any) -> Any:")
    && toolScopeMiddlewareSource.includes('config.get("configurable")')
    && !toolScopeMiddlewareSource.includes("runtime.config"),
  "Workbench tool-scope middleware must read only graph-factory RunnableConfig.configurable",
);
const middlewareToolTuple = /CANVAS_TOOL_NAMES = \(\n([\s\S]*?)\n\)/u.exec(toolScopeMiddlewareSource);
assert(middlewareToolTuple, "Workbench tool-scope middleware Canvas tuple is missing");
assertDeepEqual(
  [...middlewareToolTuple[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]),
  WORKBENCH_CANVAS_TOOLS.map((tool) => tool.name),
  "Workbench tool-scope middleware must use the canonical eight Canvas tools in order",
);
assert(
  /workbench_canvas_tools:\s*canvasToolCapability\s*\?\s*\{\s*declaredTools:/u.test(runtimeAdapter)
    && /:\s*null,\s*\n\s*model_name:/u.test(runtimeAdapter),
  "Runtime Worker must send an explicit per-Run workbench_canvas_tools.declaredTools policy or null",
);
assert(
  sha256(patchApplierSource) === patchManifest.patchApplier?.sha256,
  "DeerFlow source-patch applier does not match its manifest",
);
assert(
  sha256(patchContractTestSource) === patchManifest.contractTest?.sha256,
  "DeerFlow tool-scope contract test does not match its manifest",
);
assertDeepEqual(
  readdirSync(new URL(`${patchRoot}/`, root)).sort(),
  ["apply.py", "manifest.json", "test_workbench_tool_scope_middleware.py", "workbench_tool_scope_middleware.py"],
  "DeerFlow source-patch bundle must contain only the four audited files",
);
assert(
  patchApplierSource.includes('manifest["additionalSources"]')
    && patchApplierSource.includes("DEERFLOW_PATCH_AGENT_OUTPUT_MISMATCH")
    && patchApplierSource.includes("DEERFLOW_PATCH_MIDDLEWARE_OUTPUT_MISMATCH"),
  "DeerFlow patch applier must verify every declared patch output",
);
assert(
  patchContractTestSource.includes("test_async_model_and_tool_paths_enforce_the_same_scope")
    && patchContractTestSource.includes("test_missing_or_malformed_policy_hides_all_eight_canvas_tools")
    && patchContractTestSource.includes("test_async_non_canvas_tool_is_not_affected_by_malformed_policy"),
  "DeerFlow patch contract must cover sync/async fail-closed and non-Canvas behavior",
);
for (const requiredPreflightText of [
  "TOOL_SCOPE_PATCH_MANIFEST=",
  "--expected-commit \"$expected_commit\"",
  "io.workbench.deerflow.tool-scope-patch-sha256",
]) {
  assert(preflight.includes(requiredPreflightText), `DeerFlow preflight is missing ${requiredPreflightText}`);
}

assertDeepEqual(Object.keys(extensions).sort(), ["mcpServers", "skills"], "production extensions may contain only MCP and skill state");
assertDeepEqual(extensions.mcpServers, {}, "production extensions must not inherit legacy MCP servers");
assertDeepEqual(extensions.skills, { workbench: { enabled: true } }, "only the public workbench skill may be explicitly enabled");
assertDeepEqual(
  listShippedPublicSkills(),
  ["workbench"],
  "the mounted production public-skill root may contain only workbench",
);
assert(
  existsSync(new URL(
    "integrations/deerflow/runtime-tools/deerflow_workbench_tools/runtime_result_validator.bundle.mjs",
    root,
  )),
  "the exact Runtime result validator bundle must be shipped",
);

assertDeepEqual(fragment, {
  tool_groups: [WORKBENCH_TOOL_GROUP],
  tools: WORKBENCH_RUNTIME_TOOLS,
}, "DeerFlow config fragment must register exactly five trusted and eight Canvas tools");
assertDeepEqual(
  workbenchSkill["allowed-tools"],
  WORKBENCH_SKILL_ALLOWED_TOOLS,
  "the public workbench skill must allow every registered Workbench tool and only the audited framework tools",
);

console.log("DeerFlow production deployment contract passed.");

function readYaml(relativePath) {
  const document = YAML.parseDocument(readText(relativePath), { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS({ maxAliasCount: 100 });
}

function readText(relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith("--"), `${name} requires a value`);
  return value;
}

function readYamlFrontmatter(relativePath) {
  const source = readText(relativePath);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  assert(match, `${relativePath} must contain YAML frontmatter`);
  const document = YAML.parseDocument(match[1], { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) throw document.errors[0];
  return document.toJS({ maxAliasCount: 100 });
}

function listShippedPublicSkills() {
  const skillsRoot = new URL("integrations/deerflow/skills/", root);
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/SKILL.md`, skillsRoot)))
    .map((entry) => entry.name)
    .sort();
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

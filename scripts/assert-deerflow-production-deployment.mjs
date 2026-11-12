#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import YAML from "yaml";

import {
  WORKBENCH_CANVAS_TOOLS,
  WORKBENCH_RUNTIME_TOOLS,
  WORKBENCH_SKILL_ALLOWED_TOOLS,
  WORKBENCH_TOOL_GROUP,
  WORKBENCH_TRUSTED_TOOLS,
} from "./deerflow-workbench-tool-contract.mjs";

const root = new URL("../", import.meta.url);
const runtimeCompose = readYaml("deploy/deerflow-runtime-compose.yml");
const baseConfigExample = readYaml("deploy/deerflow-config.base.example.yaml");
const extensions = JSON.parse(readText("deploy/deerflow-extensions.production.json"));
const fragment = readYaml("integrations/deerflow/runtime-tools/config.fragment.yaml");
const workbenchSkill = readYamlFrontmatter("integrations/deerflow/skills/workbench/SKILL.md");
const workbenchSkillSource = readText("integrations/deerflow/skills/workbench/SKILL.md");
const normalizedWorkbenchSkillSource = workbenchSkillSource.replace(/\s+/gu, " ");
const envExample = readText("deploy/workbench.env.example");
const runtimeAdapter = readText("apps/workbench-worker/src/runtime/deerflow-runtime.adapter.ts");
const preflight = readText("deploy/deerflow-production-preflight.sh");
const gateway = runtimeCompose.services?.deerflow;
const patchCommit = "345f08be00c8a9495079b732a39b46aa9af1584e";
const patchRoot = `integrations/deerflow/source-patches/${patchCommit}`;
const patchManifestSource = readText(`${patchRoot}/manifest.json`);
const patchManifest = JSON.parse(patchManifestSource);
const toolScopeMiddlewareSource = readText(`${patchRoot}/workbench_tool_scope_middleware.py`);
const patchApplierSource = readText(`${patchRoot}/apply.py`);
const patchContractTestSource = readText(`${patchRoot}/test_workbench_tool_scope_middleware.py`);
const prdReferenceToolPath = "integrations/deerflow/runtime-tools/deerflow_workbench_tools/prd_reference_tool.py";
const prdReferenceToolTestPath = "integrations/deerflow/runtime-tools/test_prd_reference_tool.py";
assert(existsSync(new URL(prdReferenceToolPath, root)), "the restricted PRD reference reader module must be shipped");
assert(existsSync(new URL(prdReferenceToolTestPath, root)), "the restricted PRD reference reader contract test must be shipped");
const prdReferenceToolSource = readText(prdReferenceToolPath);
const prdReferenceToolTestSource = readText(prdReferenceToolTestPath);
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
  UV_CACHE_DIR: "/tmp/uv-cache",
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
assertDeepEqual(
  gateway.tmpfs,
  ["/tmp:size=1073741824,uid=65532,gid=65532,mode=1770"],
  "DeerFlow tmpfs must be writable by the pinned non-root runtime user",
);
for (const variable of [
  "WORKBENCH_DEERFLOW_BASE_IMAGE_REF=",
  "WORKBENCH_DEERFLOW_NODE_IMAGE_REF=",
  "WORKBENCH_DEERFLOW_IMAGE_REF=",
  "WORKBENCH_DEERFLOW_IMAGE_DIGEST=",
  "WORKBENCH_SOURCE_COMMIT=",
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
assert(String(gateway.command).includes("uv run --no-sync"), "DeerFlow must not mutate the read-only image while starting");

const configuredModel = baseConfigExample.models?.find((model) => model?.name === "deepseek-flash");
assert(configuredModel, "the DeerFlow base-config example must define the pinned deepseek-flash model");
assert(configuredModel.use === "langchain_openai:ChatOpenAI", "the DeerFlow base-config example must use the OpenAI-compatible adapter");
assert(configuredModel.model === "deepseek-flash", "the DeerFlow base-config example must pin the deepseek-flash API model");
assert(configuredModel.api_key === "$OPENAI_API_KEY", "the DeerFlow base-config example must reference the provider key by environment name");
assert(configuredModel.base_url === "$WORKBENCH_DEERFLOW_PROVIDER_BASE_URL", "the DeerFlow base-config example must reference the approved provider URL by environment name");
assert(baseConfigExample.sandbox?.use === "deerflow.sandbox.local:LocalSandboxProvider", "the DeerFlow base-config example must select the local provider explicitly");
assert(baseConfigExample.sandbox?.allow_host_bash === false, "the DeerFlow base-config example must disable host bash");

const deerflowDockerfile = readText("integrations/deerflow/Dockerfile");
for (const requiredLine of [
  "ARG DEERFLOW_BASE_IMAGE",
  "ARG DEERFLOW_NODE_IMAGE",
  "FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime",
  "FROM ${DEERFLOW_BASE_IMAGE} AS recovered-source",
  "FROM cgr.dev/chainguard/wolfi-base@sha256:",
  "ca-certificates-bundle=20260909-r3",
  "io.workbench.deerflow.runtime-base-image",
  "--mount=from=recovered-source,source=/,target=/source-ro",
  "prepare_release.py",
  "upstream-2.1.0/",
  "test_workbench_upgrade.py",
  "uv sync --locked --no-dev --python /usr/bin/python3.12",
  "uv pip check --python /app/backend/.venv/bin/python",
  "io.workbench.deerflow.base-image",
  "io.workbench.deerflow.validator-node-image",
  "io.workbench.deerflow.source-commit",
  "COPY --from=validator-runtime /usr/local/bin/node /usr/local/bin/node",
  "COPY --from=validator-runtime /usr/local/LICENSE /usr/share/licenses/node/LICENSE",
  "COPY integrations/deerflow/skills/workbench/ /app/skills/public/workbench/",
  "COPY integrations/deerflow/skills/requirement-doc-template/ /app/skills/public/requirement-doc-template/",
  "COPY integrations/deerflow/runtime-tools/deerflow_workbench_tools/ /app/backend/deerflow_workbench_tools/",
  `COPY integrations/deerflow/source-patches/${patchCommit}/ /opt/workbench/deerflow/source-patch/`,
  "USER root",
  `test \"\${DEERFLOW_SOURCE_COMMIT}\" = \"${patchCommit}\"`,
  "test_workbench_tool_scope_middleware.py",
  "--gateway-root /app/backend",
  "test_workbench_request_context.py",
  "from deerflow_workbench_tools.prd_reference_tool import workbench_prd_reference_read",
  "tool_call_schema.model_json_schema()",
  "tool.func(",
  "validate_runtime_result({})",
  "apply.py",
  "--check",
  "USER 65532:65532",
  `ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=${patchManifestSha256}`,
  "io.workbench.deerflow.tool-scope-patch-sha256",
]) {
  assert(deerflowDockerfile.includes(requiredLine), `derived DeerFlow Dockerfile is missing: ${requiredLine}`);
}
const deerflowBuildRootIndex = deerflowDockerfile.indexOf("USER root");
const deerflowPatchIndex = deerflowDockerfile.indexOf(`test \"\${DEERFLOW_SOURCE_COMMIT}\" = \"${patchCommit}\"`);
const deerflowRuntimeUserIndex = deerflowDockerfile.indexOf("USER 65532:65532");
assert(
  deerflowBuildRootIndex < deerflowPatchIndex && deerflowPatchIndex < deerflowRuntimeUserIndex,
  "derived DeerFlow Dockerfile must elevate only for the source patch and restore UID/GID 65532",
);

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
  patchManifest.agent?.upstreamSha256 === "ac72292feba8d58f59d1ebad6ce7836ee2a5240761452eda60dc8e923d95db48",
  "DeerFlow lead-agent upstream source hash drifted",
);
assert(
  patchManifest.agent?.patchedSha256 === "589d668de2390f3c55c444d229eddabfc32d1434fc7601c833ff613193a1415b",
  "DeerFlow lead-agent patched source hash drifted",
);
assert(
  patchManifest.deferredMiddleware?.sha256 === "99bcce2c2205d8ac0fcfb60a820997f30568b7d473d77edd8430e26c2fc4cbba",
  "DeerFlow middleware API source hash drifted",
);
assert(
  Array.isArray(patchManifest.additionalSources)
    && patchManifest.additionalSources.length === 3,
  "DeerFlow source patch must declare the audited subagent tool filter",
);
const subagentToolPatch = patchManifest.additionalSources[0];
assert(
  subagentToolPatch.path === "deerflow/tools/builtins/task_tool.py"
    && subagentToolPatch.upstreamSha256 === "b650fa0815fa0be406c2f612670cb71687f4df15aed6c8195545998381ff9e7d"
    && subagentToolPatch.patchedSha256 === "b46460b3aff7000d66530fd5023026b2427d7aa973bd29061ccd72a46537be30",
  "DeerFlow subagent tool filter must bind the audited upstream and patched hashes",
);
assert(
  subagentToolPatch.replacements?.some((replacement) => (
    replacement.anchor === "    # Create executor\n"
      && replacement.insertion.includes("_workbench_parent_run_tool_names")
      && replacement.insertion.includes('"workbench_generation_stage_update"')
      && replacement.insertion.includes('"workbench_artifact_draft_publish"')
      && replacement.insertion.includes('"workbench_prototype_patch_publish"')
      && replacement.insertion.includes('"workbench_knowledge_retrieve"')
      && replacement.insertion.includes('"read_file"')
      && replacement.insertion.includes('"navigate_canvas"')
      && replacement.insertion.includes("getattr(tool, \"name\", None)")
  )),
  "DeerFlow subagent patch must remove parent-run publication, Knowledge, PRD reference, and Canvas tools before executor creation",
);
assert(
  Array.isArray(patchManifest.gatewaySources)
    && patchManifest.gatewaySources.length === 3,
  "DeerFlow source patch must declare the audited Gateway context patch",
);
const gatewayContextPatch = patchManifest.gatewaySources[0];
assert(
  gatewayContextPatch.path === "app/gateway/services.py"
    && gatewayContextPatch.upstreamSha256 === "8379c34eeb2ddb46270b0e937035d5ee032dab68459b36b10435d28b8e2ab601"
    && gatewayContextPatch.patchedSha256 === "7dc25649ff92ff42c3a81ca8f23f3ce987f29e7ee00127a84f206ecd3a5cf8dc",
  "DeerFlow Gateway context patch must bind the audited upstream and patched hashes",
);
assert(
  gatewayContextPatch.replacements?.some((replacement) => (
    replacement.position === "before"
      && replacement.anchor.includes("merge_run_context_overrides")
      && replacement.insertion.includes("_WORKBENCH_SECRET_KEYS")
      && replacement.insertion.includes('"requestedArtifactKinds"')
      && replacement.insertion.includes("_WORKBENCH_REQUESTED_ARTIFACT_KINDS")
      && replacement.insertion.includes("_is_trusted_internal_caller")
  ))
    && gatewayContextPatch.replacements?.some((replacement) => (
      replacement.position === "replace"
        && replacement.insertion.includes("allow_workbench_context=trusted_internal_caller")
    ))
    && gatewayContextPatch.replacements?.some((replacement) => (
      replacement.insertion.includes("sanitized_request_config")
    )),
  "DeerFlow Gateway patch must gate and redact request-scoped Workbench context",
);
const gatewayContextPatchText = JSON.stringify(gatewayContextPatch.replacements ?? []);
assert(
  gatewayContextPatchText.includes('sanitized.pop(\\"recursion_limit\\", None)')
    && gatewayContextPatchText.includes("_DEFAULT_LEAD_GRAPH_RECURSION_LIMIT = 100")
    && gatewayContextPatchText.includes("_WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT = 200")
    && gatewayContextPatchText.includes("_WORKBENCH_LINKED_LEAD_GRAPH_RECURSION_LIMIT = 400")
    && gatewayContextPatchText.includes("_apply_workbench_lead_recursion_limit")
    && gatewayContextPatchText.includes("trusted_internal_caller is True")
    && gatewayContextPatchText.includes('set(requested_kinds) == {\\"prd\\", \\"prototype\\"}')
    && gatewayContextPatchText.includes('requested_kinds == [\\"prd\\"]'),
  "DeerFlow Gateway patch must keep bounded trusted budgets of 400 for linked delivery, 200 for PRD-only, and 100 otherwise",
);
assert(
  patchManifest.agent?.insertion?.includes("WorkbenchToolScopeMiddleware(")
    && patchManifest.agent.insertion.includes("workbench_canvas_policy_from_runnable_config(config)")
    && patchManifest.agent.insertion.includes(
      "workbench_requested_artifact_kinds_from_runnable_config(config)",
    )
    && patchManifest.agent.insertion.includes(
      "workbench_knowledge_enabled_from_runnable_config(config)",
    ),
  "DeerFlow lead-agent patch must freeze per-Run Canvas, Artifact, and Knowledge policies into the middleware",
);
assert(
  sha256(toolScopeMiddlewareSource)
    === patchManifest.toolScopeMiddleware?.sha256,
  "Workbench tool-scope middleware does not match its manifest",
);
assert(
  toolScopeMiddlewareSource.includes("def workbench_canvas_policy_from_runnable_config(config: Any) -> Any:")
    && toolScopeMiddlewareSource.includes('config.get("configurable")')
    && toolScopeMiddlewareSource.includes(
      "def workbench_requested_artifact_kinds_from_runnable_config(config: Any) -> Any:",
    )
    && toolScopeMiddlewareSource.includes(
      "def workbench_knowledge_enabled_from_runnable_config(config: Any) -> Any:",
    )
    && toolScopeMiddlewareSource.includes('context.get("workbench")')
    && !toolScopeMiddlewareSource.includes("runtime.config"),
  "Workbench tool-scope middleware must read only graph-factory RunnableConfig policy channels",
);
const prdReferencePins = [
  [
    "/mnt/skills/public/requirement-doc-template/SKILL.md",
    "fe668773ece4fb6790a59e8dc9981482def6a959079c280080a8a99600ba97e9",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/structure.md",
    "cfd9695845c2ad9bb1449bd912e8f491d008d69eb2ac88dbbe5d97868967299a",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    "16f5019a156bd13648e2c2c7ed929392f1532473a739123a5f4ca1341aa113ee",
  ],
  [
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    "76c1ae2338854cb68133fc242f7efde534278878bbd89e297a4f8ee010479065",
  ],
];
const canonicalPrdReferenceReader = {
  name: "read_file",
  group: "workbench",
  use: "deerflow_workbench_tools.prd_reference_tool:workbench_prd_reference_read",
};
assertDeepEqual(
  WORKBENCH_TRUSTED_TOOLS.filter((tool) => tool.name === canonicalPrdReferenceReader.name),
  [canonicalPrdReferenceReader],
  "the trusted tool contract must register exactly the restricted PRD read_file implementation",
);
assert(
  prdReferenceToolSource.includes("class PrdReferenceSpec:")
    && prdReferenceToolSource.includes("@dataclass(frozen=True)")
    && prdReferenceToolSource.includes("MappingProxyType({")
    && prdReferenceToolSource.includes('@tool("read_file", parse_docstring=True)')
    && prdReferenceToolSource.includes("def workbench_prd_reference_read(")
    && prdReferenceToolSource.includes('"prd" not in requested_artifact_kinds')
    && prdReferenceToolSource.includes("reference = PRD_REFERENCE_FILES.get(path)")
    && prdReferenceToolSource.includes("content = reference.physical_path.read_bytes()")
    && prdReferenceToolSource.includes("actual_sha256 = hashlib.sha256(content).hexdigest()")
    && prdReferenceToolSource.includes('content.decode("utf-8", errors="strict")')
    && prdReferencePins.every(([virtualPath, digest]) => (
      prdReferenceToolSource.includes(`"${virtualPath}"`)
        && prdReferenceToolSource.includes(`"${virtualPath.replace(/^\/mnt/u, "/app")}"`)
        && prdReferenceToolSource.includes(`sha256="${digest}"`)
    )),
  "the PRD reference reader must map only pinned virtual paths to complete immutable image files",
);
const prdReferenceReaderSignature = /def workbench_prd_reference_read\(\n([\s\S]*?)\n\) -> str:/u
  .exec(prdReferenceToolSource)?.[1];
assert(
  prdReferenceReaderSignature?.includes("runtime: Runtime")
    && prdReferenceReaderSignature.includes("description: str")
    && prdReferenceReaderSignature.includes("path: PrdReferencePath")
    && !prdReferenceReaderSignature.includes("start_line")
    && !prdReferenceReaderSignature.includes("end_line")
    && !prdReferenceReaderSignature.includes("file_path"),
  "the PRD reference reader schema must expose one complete whitelisted path without range or alias parameters",
);
assert(
  prdReferenceToolTestSource.includes(
    "test_schema_is_named_read_file_and_allows_only_four_complete_paths",
  )
    && prdReferenceToolTestSource.includes(
      "test_reads_each_exact_static_path_and_returns_complete_utf8_unchanged",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_aliases_traversal_and_non_path_alias_parameters",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_missing_malformed_and_non_prd_scope",
    )
    && prdReferenceToolTestSource.includes(
      "test_allows_linked_prd_and_prototype_scope",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_content_that_does_not_match_the_pinned_sha256",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_non_utf8_after_the_pinned_byte_hash_matches",
    ),
  "the PRD reference reader contract must cover schema, scope, traversal, integrity, and UTF-8 failures",
);
assert(
  toolScopeMiddlewareSource.includes('self._prd_gate_enabled = normalized_kinds is not None and "prd" in normalized_kinds')
    && toolScopeMiddlewareSource.includes('self._prd_auto_enabled = normalized_kinds == ["prd"]')
    && prdReferencePins.every(([path, digest]) => (
      toolScopeMiddlewareSource.includes(`"${path}"`)
        && toolScopeMiddlewareSource.includes(`"${digest}"`)
    ))
    && toolScopeMiddlewareSource.includes('hashlib.sha256(content.encode("utf-8")).hexdigest()')
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH"),
  "Workbench PRD gate must protect every PRD request and bind exact Runtime reference paths and SHA-256 pins",
);
const prdErrorToolMessage = /def _error_tool_message\([\s\S]*?\n\s*\)\n\n\nclass WorkbenchToolScopeMiddleware/u
  .exec(toolScopeMiddlewareSource)?.[0];
assert(
  prdErrorToolMessage?.includes("ToolMessage(")
    && prdErrorToolMessage.includes("tool_call_id=(call_id")
    && prdErrorToolMessage.includes("name=(name")
    && prdErrorToolMessage.includes('status="error"'),
  "Workbench PRD correction errors must return a direct ToolMessage on the original call identity",
);
assert(
  toolScopeMiddlewareSource.includes(
    "if name in {ARTIFACT_DRAFT_TOOL_NAME, RUNTIME_RESULT_TOOL_NAME}:",
  )
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_PUBLICATION_BATCH_INVALID")
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_DRAFT_REQUIRED")
    && toolScopeMiddlewareSource.includes("_successful_prd_drafts(")
    && toolScopeMiddlewareSource.includes("_successful_runtime_results("),
  "Workbench PRD gate must enforce one draft, one final result, and publication batch protection",
);
const middlewareToolTuple = /CANVAS_TOOL_NAMES = \(\n([\s\S]*?)\n\)/u.exec(toolScopeMiddlewareSource);
assert(middlewareToolTuple, "Workbench tool-scope middleware Canvas tuple is missing");
assertDeepEqual(
  [...middlewareToolTuple[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]),
  WORKBENCH_CANVAS_TOOLS.map((tool) => tool.name),
  "Workbench tool-scope middleware must use the canonical eight Canvas tools in order",
);
const artifactProgressToolTuple = /ARTIFACT_PROGRESS_TOOL_NAMES = \(\n([\s\S]*?)\n\)/u.exec(toolScopeMiddlewareSource);
assert(artifactProgressToolTuple, "Workbench tool-scope middleware Artifact progress tuple is missing");
assertDeepEqual(
  [...artifactProgressToolTuple[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]),
  [
    "workbench_generation_stage_update",
    "workbench_artifact_draft_publish",
  ],
  "Workbench tool-scope middleware must expose Stage and Draft to PRD and Prototype Runs",
);
const prototypeOnlyToolTuple = /PROTOTYPE_ONLY_TOOL_NAMES = \(\n([\s\S]*?)\n\)/u.exec(toolScopeMiddlewareSource);
assert(prototypeOnlyToolTuple, "Workbench tool-scope middleware Prototype-only tuple is missing");
assertDeepEqual(
  [...prototypeOnlyToolTuple[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]),
  ["workbench_prototype_patch_publish"],
  "Workbench tool-scope middleware must keep Prototype patch publication Prototype-only",
);
assert(
  /workbench_canvas_tools:\s*canvasToolCapability\s*\?\s*\{\s*declaredTools:/u.test(runtimeAdapter)
    && /:\s*null,\s*\n\s*model_name:/u.test(runtimeAdapter),
  "Runtime Worker must send an explicit per-Run workbench_canvas_tools.declaredTools policy or null",
);
assert(
  /requestedArtifactKinds:\s*\[\.\.\.execution\.request\.requestedArtifactKinds\]/u.test(runtimeAdapter),
  "Runtime Worker must send requested Artifact kinds through the trusted Workbench context",
);
assert(
  /\.\.\.\(knowledgeToolCapability \? \{ knowledgeEnabled: true \} : \{\}\)/u.test(runtimeAdapter),
  "Runtime Worker must declare Knowledge visibility only when a request-scoped capability exists",
);
assert(
  /subagent_enabled:\s*execution\.request\.requestedArtifactKinds\.some\([\s\S]*?kind === "prototype" \|\| kind === "code"/u
    .test(runtimeAdapter)
    && !runtimeAdapter.includes("subagent_enabled: true"),
  "Runtime Worker must enable delegation only for Prototype or code Runs",
);
assert(
  sha256(patchApplierSource) === patchManifest.patchApplier?.sha256,
  "DeerFlow source-patch applier does not match its manifest",
);
assert(
  sha256(patchContractTestSource) === patchManifest.contractTest?.sha256,
  "DeerFlow tool-scope contract test does not match its manifest",
);
const patchRequestContextTestSource = readText(`${patchRoot}/test_workbench_request_context.py`);
assert(
  sha256(patchRequestContextTestSource) === patchManifest.requestContextTest?.sha256,
  "DeerFlow request-context contract test does not match its manifest",
);
assert(
  patchRequestContextTestSource.includes("test_trusted_linked_scope_receives_a_bounded_budget_in_either_order")
    && patchRequestContextTestSource.includes("test_joint_budget_requires_a_literal_trusted_internal_identity")
    && patchRequestContextTestSource.includes("test_non_prd_malformed_untrusted_and_forged_fields_keep_default_budget"),
  "DeerFlow request-context tests must cover trusted linked budgets and reject forged or malformed scope",
);
assert(
  sha256(readText(`${patchRoot}/test_workbench_upgrade.py`)) === patchManifest.upgradeTest?.sha256,
  "DeerFlow upgrade compatibility tests must match their manifest",
);
assertDeepEqual(
  patchManifest.additionalSources.map((source) => source.path),
  ["deerflow/tools/builtins/task_tool.py", "deerflow/runtime/checkpoint_state.py", "deerflow/runtime/runs/worker.py"],
  "DeerFlow must retain subagent isolation, materialized history filtering and fallback rollback",
);
assertDeepEqual(
  patchManifest.gatewaySources.map((source) => source.path),
  ["app/gateway/services.py", "app/gateway/routers/threads.py", "app/gateway/routers/thread_runs.py"],
  "DeerFlow must retain authenticated Workbench context, history bindings and offset pagination",
);
assertDeepEqual(
  readdirSync(new URL(`${patchRoot}/`, root)).sort(),
  ["apply.py", "manifest.json", "test_workbench_request_context.py", "test_workbench_tool_scope_middleware.py", "test_workbench_upgrade.py", "workbench_tool_scope_middleware.py"],
  "DeerFlow source-patch bundle must contain only the audited files",
);
assert(
  patchApplierSource.includes('manifest["additionalSources"]')
    && patchApplierSource.includes('manifest["gatewaySources"]')
    && patchApplierSource.includes("DEERFLOW_PATCH_AGENT_OUTPUT_MISMATCH")
    && patchApplierSource.includes("DEERFLOW_PATCH_MIDDLEWARE_OUTPUT_MISMATCH"),
  "DeerFlow patch applier must verify every declared patch output",
);
assert(
  patchContractTestSource.includes("test_async_model_and_tool_paths_enforce_the_same_scope")
    && patchContractTestSource.includes(
      "test_async_prd_and_prototype_model_binding_enforces_artifact_visibility_matrix",
    )
    && patchContractTestSource.includes(
      "test_async_prd_and_prototype_tool_execution_enforces_artifact_scope_matrix",
    )
    && patchContractTestSource.includes(
      "test_artifact_progress_tools_are_visible_for_prd_and_prototype",
    )
    && patchContractTestSource.includes("test_missing_or_malformed_policy_hides_all_eight_canvas_tools")
    && patchContractTestSource.includes("test_knowledge_execution_is_blocked_without_calling_the_handler")
    && patchContractTestSource.includes("test_async_knowledge_tool_execution_is_fail_closed")
    && patchContractTestSource.includes("test_async_non_canvas_tool_is_not_affected_by_malformed_policy")
    && patchContractTestSource.includes(
      "test_prd_gate_allows_ordered_reference_reads_in_one_batch",
    )
    && patchContractTestSource.includes(
      "test_prd_gate_requires_exact_unranged_path_and_pinned_handler_content",
    )
    && patchContractTestSource.includes(
      "test_prd_reference_reader_is_blocked_when_prd_is_not_requested",
    )
    && patchContractTestSource.includes(
      "test_linked_run_keeps_prd_draft_then_publishes_prototype_before_combined_result",
    )
    && patchContractTestSource.includes(
      "test_linked_reference_preflight_preserves_args_and_rejects_invalid_reference",
    )
    && patchContractTestSource.includes(
      "test_linked_full_body_drift_still_fails_without_replacing_content",
    )
    && patchContractTestSource.includes(
      "test_final_reference_guidance_requires_complete_trusted_verified_history",
    )
    && patchContractTestSource.includes(
      "test_prd_clarification_is_hidden_and_blocked_without_calling_the_handler",
    )
    && patchContractTestSource.includes(
      "test_real_middleware_chain_hides_clarification_from_prd_model_binding",
    )
    && patchContractTestSource.includes(
      "test_prd_gate_enforces_stage_draft_final_sequence_and_allows_correction",
    )
    && patchContractTestSource.includes(
      "test_async_prd_gate_blocks_early_final_and_allows_corrected_final",
    )
    && patchContractTestSource.includes(
      "test_async_prd_gate_validates_ordered_reference_handler_output",
    )
    && patchContractTestSource.includes(
      "test_prd_reference_pins_match_every_shipped_runtime_file",
    ),
  "DeerFlow patch contract must cover async scope enforcement and the self-correcting PRD workflow gate",
);
assert(
  patchRequestContextTestSource.includes("test_only_an_authenticated_internal_caller_can_deliver_workbench_channels")
    && patchRequestContextTestSource.includes("test_untrusted_context_is_fail_closed_and_persistence_config_is_redacted")
    && patchRequestContextTestSource.includes("test_knowledge_visibility_requires_the_exact_true_flag_and_capability")
    && patchRequestContextTestSource.includes("test_malformed_scope_does_not_create_a_runtime_secret_channel")
    && patchRequestContextTestSource.includes("test_exact_trusted_prd_scope_receives_the_named_recursion_budget")
    && patchRequestContextTestSource.includes("test_non_prd_malformed_untrusted_and_forged_fields_keep_default_budget"),
  "DeerFlow request-context contract must cover caller auth, redaction, and malformed scope",
);
assert(
  /self\._knowledge_enabled = knowledge_enabled is True/u.test(toolScopeMiddlewareSource)
    && /name == KNOWLEDGE_TOOL_NAME and not self\._knowledge_enabled/u.test(toolScopeMiddlewareSource)
    && toolScopeMiddlewareSource.includes("WORKBENCH_KNOWLEDGE_TOOL_NOT_AUTHORIZED"),
  "DeerFlow middleware must hide and block Knowledge unless the trusted scope is exactly true",
);
assert(
  toolScopeMiddlewareSource.includes('CLARIFICATION_TOOL_NAME = "ask_clarification"')
    && /name == CLARIFICATION_TOOL_NAME and self\._prd_gate_enabled/u.test(toolScopeMiddlewareSource)
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_CLARIFICATION_NOT_SUPPORTED")
    && toolScopeMiddlewareSource.includes("<workbench_prd_clarification_policy>")
    && toolScopeMiddlewareSource.includes("Ignore any general instruction that requires clarification")
    && /overrides\["system_message"\] = SystemMessage/u.test(toolScopeMiddlewareSource),
  "PRD Runtime must override generic clarification instructions, hide the tool, and fail closed on execution",
);
assert(
  normalizedWorkbenchSkillSource.includes("no free-form clarification resume path")
    && normalizedWorkbenchSkillSource.includes("never call `ask_clarification`")
    && normalizedWorkbenchSkillSource.includes("still complete the PRD")
    && normalizedWorkbenchSkillSource.includes("Missing knowledge is a blocker")
    && normalizedWorkbenchSkillSource.includes("Every artifact requires nonempty citations")
    && normalizedWorkbenchSkillSource.includes("Do not stop after the PRD Draft in a linked Run")
    && !normalizedWorkbenchSkillSource.includes("otherwise request input")
    && !normalizedWorkbenchSkillSource.includes("or use clarification where"),
  "Workbench skill must complete PRDs without the unsupported clarification path",
);
assert(
  toolScopeMiddlewareSource.includes('READ_FILE_TOOL_NAME = "read_file"')
    && toolScopeMiddlewareSource.includes(
      "if name == READ_FILE_TOOL_NAME and not self._prd_gate_enabled:",
    )
    && toolScopeMiddlewareSource.includes(
      "elif name == READ_FILE_TOOL_NAME and not self._prd_gate_enabled:",
    )
    && toolScopeMiddlewareSource.includes(
      '_PRD_REFERENCE_BLOCK_CODE = "WORKBENCH_PRD_REFERENCE_TOOL_NOT_AUTHORIZED"',
    ),
  "DeerFlow middleware must hide and block the PRD reference reader when no PRD is requested",
);
const taskToolPatch = patchManifest.additionalSources.find(
  (entry) => entry.path === "deerflow/tools/builtins/task_tool.py",
);
const taskToolPatchText = JSON.stringify(taskToolPatch?.replacements ?? []);
assert(
  taskToolPatchText.includes("workbench_knowledge_retrieve")
    && taskToolPatchText.includes("read_file")
    && taskToolPatchText.includes("_workbench_parent_run_tool_names")
    && taskToolPatchText.includes('if getattr(tool, \\"name\\", None) not in _workbench_parent_run_tool_names'),
  "DeerFlow subagents must remove Knowledge and every parent-Run publication, PRD reference, and Canvas tool",
);
const gatewayPatchText = JSON.stringify(patchManifest.gatewaySources);
assert(
  gatewayPatchText.includes('scope.get(\\"knowledgeEnabled\\") is True')
    && gatewayPatchText.includes('WORKBENCH_KNOWLEDGE_CAPABILITY\\" not in secrets')
    && gatewayPatchText.includes('secrets.pop(\\"WORKBENCH_KNOWLEDGE_CAPABILITY\\", None)'),
  "DeerFlow Gateway must couple Knowledge visibility and capability in both directions",
);
for (const requiredPreflightText of [
  "TOOL_SCOPE_PATCH_MANIFEST=",
  "--expected-commit \"$expected_commit\"",
  "io.workbench.deerflow.tool-scope-patch-sha256",
  "assert-deerflow-runtime-config.mjs",
  "WORKBENCH_RUNTIME_VALIDATOR_IMAGE_PROBE_FAILED",
  "--network none",
  "--user 65532:65532",
]) {
  assert(preflight.includes(requiredPreflightText), `DeerFlow preflight is missing ${requiredPreflightText}`);
}

assertDeepEqual(Object.keys(extensions).sort(), ["mcpServers", "skills"], "production extensions may contain only MCP and skill state");
assertDeepEqual(extensions.mcpServers, {}, "production extensions must not inherit legacy MCP servers");
assertDeepEqual(extensions.skills, {
  "requirement-doc-template": { enabled: true },
  workbench: { enabled: true },
}, "only the canonical requirement-document and workbench skills may be explicitly enabled");
assertDeepEqual(
  listShippedPublicSkills(),
  ["requirement-doc-template", "workbench"],
  "the production public-skill root must contain only the canonical requirement-document and workbench skills",
);
for (const [relativePath, expectedDigest] of [
  ["SKILL.md", "fe668773ece4fb6790a59e8dc9981482def6a959079c280080a8a99600ba97e9"],
  ["agents/openai.yaml", "f93830939dc43fc1adbb565cc579b0181b8ac291b9c0e9ae8e3d242d73b0a988"],
  ["assets/requirement-template.docx", "9e1abdd5c63b2ee8224f68d129e4df8d2bb63835c754012e04b73ce053d85aa6"],
  ["references/quality-standards.md", "16f5019a156bd13648e2c2c7ed929392f1532473a739123a5f4ca1341aa113ee"],
  ["references/structure.md", "cfd9695845c2ad9bb1449bd912e8f491d008d69eb2ac88dbbe5d97868967299a"],
  ["scripts/docx_quality_check.py", "aab6a8ac17d53e1ca9de20aa97b17dbe8c811db7bd23bc86ec57563b68169fdb"],
]) {
  const source = readFileSync(new URL(
    `integrations/deerflow/skills/requirement-doc-template/${relativePath}`,
    root,
  ));
  assert(
    sha256(source) === expectedDigest,
    `vendored requirement-doc-template file does not match the canonical source: ${relativePath}`,
  );
}
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
}, "DeerFlow config fragment must register exactly six trusted and eight Canvas tools");
assertDeepEqual(
  [WORKBENCH_TRUSTED_TOOLS.length, WORKBENCH_CANVAS_TOOLS.length, WORKBENCH_RUNTIME_TOOLS.length],
  [6, 8, 14],
  "the canonical Workbench tool contract must contain six trusted and eight Canvas tools",
);
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

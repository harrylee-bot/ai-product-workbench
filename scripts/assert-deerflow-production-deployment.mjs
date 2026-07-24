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
  "WORKBENCH_IMAGE_INVENTORY_BUNDLE_PATH=",
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
assert(String(gateway.command).includes("uv run --no-sync"), "DeerFlow must not mutate the read-only image while starting");

const configuredModel = baseConfigExample.models?.find((model) => model?.name === "gpt-5.5");
assert(configuredModel, "the DeerFlow base-config example must define the pinned gpt-5.5 model");
assert(configuredModel.use === "langchain_openai:ChatOpenAI", "the DeerFlow base-config example must use the OpenAI-compatible adapter");
assert(configuredModel.model === "gpt-5.5", "the DeerFlow base-config example must pin the gpt-5.5 API model");
assert(configuredModel.api_key === "$OPENAI_API_KEY", "the DeerFlow base-config example must reference the provider key by environment name");
assert(configuredModel.base_url === "$WORKBENCH_DEERFLOW_PROVIDER_BASE_URL", "the DeerFlow base-config example must reference the approved provider URL by environment name");
assert(baseConfigExample.sandbox?.use === "deerflow.sandbox.local:LocalSandboxProvider", "the DeerFlow base-config example must select the local provider explicitly");
assert(baseConfigExample.sandbox?.allow_host_bash === false, "the DeerFlow base-config example must disable host bash");

const deerflowDockerfile = readText("integrations/deerflow/Dockerfile");
for (const requiredLine of [
  "ARG DEERFLOW_BASE_IMAGE",
  "ARG DEERFLOW_NODE_IMAGE",
  "FROM ${DEERFLOW_NODE_IMAGE} AS validator-runtime",
  "FROM ${DEERFLOW_BASE_IMAGE} AS runtime",
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
  patchManifest.agent?.upstreamSha256 === "9052cfadca31817a927e83ad2dff01bfe5afdf5acdae337cc8f30eb1a8d8469f",
  "DeerFlow lead-agent upstream source hash drifted",
);
assert(
  patchManifest.agent?.patchedSha256 === "6d03a535d9d4f45d3a1725363ef80e943af5db934df2ec068f4427e6b0c8295d",
  "DeerFlow lead-agent patched source hash drifted",
);
assert(
  patchManifest.deferredMiddleware?.sha256 === "d0fb92b78bf7d65a3444925a7cef4a1072f464127b75393fdaf5f1fb7d9053f2",
  "DeerFlow middleware API source hash drifted",
);
assert(
  Array.isArray(patchManifest.additionalSources)
    && patchManifest.additionalSources.length === 1,
  "DeerFlow source patch must declare the audited subagent tool filter",
);
const subagentToolPatch = patchManifest.additionalSources[0];
assert(
  subagentToolPatch.path === "deerflow/tools/builtins/task_tool.py"
    && subagentToolPatch.upstreamSha256 === "bbbf58869ea4e24a8c230695478fb5d09fd35c2e4dbb2c16bc5052871027ee95"
    && subagentToolPatch.patchedSha256 === "482292649c09ca8112ab30bd5e96baa9032aeccbfe3e3770000e1fbb41309317",
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
    && patchManifest.gatewaySources.length === 1,
  "DeerFlow source patch must declare the audited Gateway context patch",
);
const gatewayContextPatch = patchManifest.gatewaySources[0];
assert(
  gatewayContextPatch.path === "app/gateway/services.py"
    && gatewayContextPatch.upstreamSha256 === "4d445c3ed264b346f419204f88073868db7030b2ae307eb6c496ef6f5755eb34"
    && gatewayContextPatch.patchedSha256 === "46c8c98fbdf94876603012d922c91ee7a2ece03c07a6ccf30d63a43086e1fdcb",
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
    && gatewayContextPatchText.includes("_apply_workbench_lead_recursion_limit")
    && gatewayContextPatchText.includes('requestedArtifactKinds\\") == [\\"prd\\"]'),
  "DeerFlow Gateway patch must grant the bounded 200-step budget only to trusted PRD-only Runs",
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
    "f59cf65306078cdcdc7cc98486860a47f20ff80b81f0a849af381494183c78e1",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/structure.md",
    "9d0a8f6efe520809cb4e6cf94dd4d4f55f6a21ef52338ccbb6667419a11352a5",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    "45e76fe4c178e8609cd1dd3c4a6c9642c280a219b0470295b3204e469a6b4168",
  ],
  [
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    "bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
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
    && prdReferenceToolSource.includes('requested_artifact_kinds != ["prd"]')
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
      "test_rejects_missing_malformed_non_prd_and_mixed_scope",
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
  toolScopeMiddlewareSource.includes('self._prd_gate_enabled = normalized_kinds == ["prd"]')
    && prdReferencePins.every(([path, digest]) => (
      toolScopeMiddlewareSource.includes(`"${path}"`)
        && toolScopeMiddlewareSource.includes(`"${digest}"`)
    ))
    && toolScopeMiddlewareSource.includes('hashlib.sha256(content.encode("utf-8")).hexdigest()')
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH"),
  "Workbench PRD gate must be PRD-only and bind exact Runtime reference paths and SHA-256 pins",
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
    && toolScopeMiddlewareSource.includes("_successful_prd_drafts(request.state)")
    && toolScopeMiddlewareSource.includes("_successful_runtime_results(request.state)"),
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
assertDeepEqual(
  readdirSync(new URL(`${patchRoot}/`, root)).sort(),
  ["apply.py", "manifest.json", "test_workbench_request_context.py", "test_workbench_tool_scope_middleware.py", "workbench_tool_scope_middleware.py"],
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
      "test_prd_reference_reader_is_blocked_outside_exact_prd_runs",
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
  "DeerFlow middleware must hide and block the PRD reference reader outside an exact PRD Run",
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
  ["SKILL.md", "f59cf65306078cdcdc7cc98486860a47f20ff80b81f0a849af381494183c78e1"],
  ["agents/openai.yaml", "f93eee46ee2b76146c7d2b212f6c26da3c16b28d566eac0a3158c92f9425afc0"],
  ["assets/requirement-template.docx", "3070777f5c624be731bd264f72955ca4d15d5ac68d20867318ce8c0081789ebf"],
  ["references/quality-standards.md", "45e76fe4c178e8609cd1dd3c4a6c9642c280a219b0470295b3204e469a6b4168"],
  ["references/structure.md", "9d0a8f6efe520809cb4e6cf94dd4d4f55f6a21ef52338ccbb6667419a11352a5"],
  ["scripts/docx_quality_check.py", "722aa28067ef0d34233191275440285dcee68b0764eb55d65f5bec8e16b8cf21"],
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

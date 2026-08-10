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
const patchCommit = "7a6c4a994a86583d2a3c056ee9d0f157d4f030c2";
const patchRoot = `integrations/deerflow/source-patches/${patchCommit}`;
const patchManifestSource = readText(`${patchRoot}/manifest.json`);
const patchManifest = JSON.parse(patchManifestSource);
const toolScopeMiddlewareSource = readText(`${patchRoot}/workbench_tool_scope_middleware.py`);
const patchApplierSource = readText(`${patchRoot}/apply.py`);
const patchContractTestSource = readText(`${patchRoot}/test_workbench_tool_scope_middleware.py`);
const prdReferenceToolPath = "integrations/deerflow/runtime-tools/deerflow_workbench_tools/prd_reference_tool.py";
const prdReferenceToolTestPath = "integrations/deerflow/runtime-tools/test_prd_reference_tool.py";
const prototypeNormalizerPath = "integrations/deerflow/runtime-tools/deerflow_workbench_tools/prototype_runtime_normalizer.py";
const prototypeNormalizerTestPath = "integrations/deerflow/runtime-tools/test_prototype_runtime_normalizer.py";
assert(existsSync(new URL(prdReferenceToolPath, root)), "the restricted PRD reference reader module must be shipped");
assert(existsSync(new URL(prdReferenceToolTestPath, root)), "the restricted PRD reference reader contract test must be shipped");
assert(existsSync(new URL(prototypeNormalizerPath, root)), "the Prototype runtime normalizer module must be shipped");
assert(existsSync(new URL(prototypeNormalizerTestPath, root)), "the Prototype runtime normalizer contract test must be shipped");
const prdReferenceToolSource = readText(prdReferenceToolPath);
const prdReferenceToolTestSource = readText(prdReferenceToolTestPath);
const prototypeNormalizerSource = readText(prototypeNormalizerPath);
const prototypeNormalizerTestSource = readText(prototypeNormalizerTestPath);
const patchManifestSha256 = sha256(patchManifestSource);
const prototypeNormalizerSha256 = "c5a57d4d0d556c2d2aa7f933dbc699cb642af88d877198d7553a6cecd64a1eb6";
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
assert(baseConfigExample.database?.backend === "sqlite", "the DeerFlow base-config example must select a durable SQLite backend");
assert(baseConfigExample.database?.sqlite_dir === ".deer-flow/data", "the DeerFlow base-config example must keep SQLite data beneath .deer-flow");

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
  "configured_tools",
  "tool_call_schema.model_json_schema()",
  "tool.func(",
  "validate_runtime_result({})",
  "apply.py",
  "--check",
  "USER 65532:65532",
  `ARG WORKBENCH_DEERFLOW_TOOL_SCOPE_PATCH_SHA256=${patchManifestSha256}`,
  "io.workbench.deerflow.tool-scope-patch-sha256",
  `ARG WORKBENCH_DEERFLOW_PROTOTYPE_NORMALIZER_SHA256=${prototypeNormalizerSha256}`,
  "io.workbench.deerflow.prototype-normalizer-sha256",
  "sha256sum /app/backend/deerflow_workbench_tools/prototype_runtime_normalizer.py",
]) {
  assert(deerflowDockerfile.includes(requiredLine), `derived DeerFlow Dockerfile is missing: ${requiredLine}`);
}
assert(
  sha256(prototypeNormalizerSource) === prototypeNormalizerSha256,
  "Prototype runtime normalizer source hash drifted",
);
for (const trustedTool of WORKBENCH_TRUSTED_TOOLS) {
  const [moduleName, functionName] = trustedTool.use.split(":");
  assert(deerflowDockerfile.includes(moduleName), `derived DeerFlow Dockerfile does not probe ${moduleName}`);
  assert(deerflowDockerfile.includes(functionName), `derived DeerFlow Dockerfile does not probe ${functionName}`);
  assert(preflight.includes(moduleName), `DeerFlow preflight does not probe ${moduleName}`);
  assert(preflight.includes(functionName), `DeerFlow preflight does not probe ${functionName}`);
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
  patchManifest.agent?.patchedSha256 === "3dce9051f0ce8248c44f7e6a9e4b8b186ef061a39bce28548cb40557dc1c255a",
  "DeerFlow lead-agent patched source hash drifted",
);
assert(
  patchManifest.deferredMiddleware?.sha256 === "d0fb92b78bf7d65a3444925a7cef4a1072f464127b75393fdaf5f1fb7d9053f2",
  "DeerFlow middleware API source hash drifted",
);
assert(
  Array.isArray(patchManifest.additionalSources)
    && patchManifest.additionalSources.length === 2,
  "DeerFlow source patch must declare the audited subagent filter and RunManager merge patches",
);
const subagentToolPatch = patchManifest.additionalSources.find(
  (entry) => entry?.path === "deerflow/tools/builtins/task_tool.py",
);
assert(
  subagentToolPatch?.path === "deerflow/tools/builtins/task_tool.py"
    && subagentToolPatch.upstreamSha256 === "bbbf58869ea4e24a8c230695478fb5d09fd35c2e4dbb2c16bc5052871027ee95"
    && subagentToolPatch.patchedSha256 === "13cb41b838d20a664438318a0e207ef6f8c80e7bc4923bab1e6a0ae0c2c101d8",
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
  ))
    && subagentToolPatch.replacements?.some((replacement) => (
      replacement.position === "before"
        && replacement.anchor.includes('"workbench_knowledge_retrieve"')
        && replacement.insertion.includes('"workbench_runtime_result_submit"')
    )),
  "DeerFlow subagent patch must remove parent-run publication, Knowledge, PRD reference, and Canvas tools before executor creation",
);
const runManagerPatch = patchManifest.additionalSources.find(
  (entry) => entry?.path === "deerflow/runtime/runs/manager.py",
);
assert(
  runManagerPatch?.upstreamSha256 === "ffd222f06bd46894196ed016d5f78efeb1078511e2b35a0ecab6c59c9d33463a"
    && runManagerPatch.patchedSha256 === "c8e849c5dfb53495594e139c3adecd04e570a57942940b5f46b93d14be8732b1",
  "DeerFlow RunManager merge patch must bind the audited upstream and patched hashes",
);
const runManagerPatchText = JSON.stringify(runManagerPatch.replacements ?? []);
assert(
  runManagerPatchText.includes("store_limit = max(0, limit - len(memory_records))")
    && runManagerPatchText.includes("store_limit = limit + len(records_by_id)")
    && runManagerPatchText.includes("duplicate slots"),
  "DeerFlow RunManager must fetch through memory/store duplicates before trimming the unique newest page",
);
assert(
  Array.isArray(patchManifest.gatewaySources)
    && patchManifest.gatewaySources.length === 3,
  "DeerFlow source patch must declare the audited Gateway context, checkpoint-history, and run-pagination patches",
);
const gatewayContextPatch = patchManifest.gatewaySources.find(
  (entry) => entry?.path === "app/gateway/services.py",
);
assert(
  gatewayContextPatch?.path === "app/gateway/services.py"
    && gatewayContextPatch.upstreamSha256 === "4d445c3ed264b346f419204f88073868db7030b2ae307eb6c496ef6f5755eb34"
    && gatewayContextPatch.patchedSha256 === "d6f9f0ec0a2036d45832149d989eb9e15d644d9cbd98787b84a826ad79de8b33",
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
    ))
    && gatewayContextPatch.replacements?.some((replacement) => (
      replacement.insertion.includes("def _bind_server_run_id")
        && replacement.insertion.includes('metadata["run_id"] = run_id')
    ))
    && gatewayContextPatch.replacements?.some((replacement) => (
      replacement.insertion.includes("_bind_server_run_id(config, record.run_id)")
    )),
  "DeerFlow Gateway patch must gate request context and bind checkpoint metadata to the server Run",
);
const gatewayContextPatchText = JSON.stringify(gatewayContextPatch.replacements ?? []);
assert(
  gatewayContextPatchText.includes('sanitized.pop(\\"recursion_limit\\", None)')
    && gatewayContextPatchText.includes("_DEFAULT_LEAD_GRAPH_RECURSION_LIMIT = 100")
    && gatewayContextPatchText.includes("_WORKBENCH_PRD_LEAD_GRAPH_RECURSION_LIMIT = 600")
    && gatewayContextPatchText.includes("_WORKBENCH_PROTOTYPE_CODE_LEAD_GRAPH_RECURSION_LIMIT = 400")
    && gatewayContextPatchText.includes("_apply_workbench_lead_recursion_limit")
    && gatewayContextPatchText.includes('requestedArtifactKinds\\")\\n        if normalized_scope is not None')
    && gatewayContextPatchText.includes('requested_artifact_kinds == [\\"prd\\"]')
    && gatewayContextPatchText.includes('requested_artifact_kinds in ([\\"prototype\\"], [\\"code\\"])'),
  "DeerFlow Gateway patch must grant bounded artifact-specific budgets only to trusted single-kind PRD, Prototype, or Code Runs",
);
const checkpointHistoryPatch = patchManifest.gatewaySources.find(
  (entry) => entry?.path === "app/gateway/routers/threads.py",
);
assert(
  checkpointHistoryPatch?.upstreamSha256 === "19784e84a87c9a63b10a3188a1c3c6d6f9d13234599a57bad22ef252140cd7f3"
    && checkpointHistoryPatch?.patchedSha256 === "115109b776847239570786e2448539e41bbbc99c28e63bcc2d989625cfa4a6e1",
  "DeerFlow checkpoint-history patch must bind the audited upstream and patched hashes",
);
const checkpointHistoryPatchText = JSON.stringify(checkpointHistoryPatch.replacements ?? []);
assert(
  checkpointHistoryPatchText.includes("Checkpoint metadata filter")
    && checkpointHistoryPatchText.includes("filter=body.metadata or None")
    && checkpointHistoryPatchText.includes("_WORKBENCH_RUN_HISTORY_METADATA_KEYS")
    && checkpointHistoryPatchText.includes("workbench_provider_idempotency_key")
    && checkpointHistoryPatchText.includes("workbench_attempt")
    && checkpointHistoryPatchText.includes("History metadata attempt must be a positive integer")
    && checkpointHistoryPatchText.includes("History metadata filter values must be bounded identifiers")
    && checkpointHistoryPatchText.includes("character.isascii()"),
  "DeerFlow history endpoint must forward only a bounded exact Workbench Run metadata filter",
);
const runPaginationPatch = patchManifest.gatewaySources.find(
  (entry) => entry?.path === "app/gateway/routers/thread_runs.py",
);
assert(
  runPaginationPatch?.upstreamSha256 === "7f303c5e61ef202000010d93b8761cfbb0ec445f9b79131bcd3e70d3ebcdda70"
    && runPaginationPatch?.patchedSha256 === "f829a02bf04c15806c92afaccda2e57a858a67317e1c6091edfdfa4767aafa63",
  "DeerFlow run-list pagination patch must bind the audited upstream and patched hashes",
);
const runPaginationReplacement = runPaginationPatch.replacements?.find(
  (replacement) => replacement.anchor.includes("async def list_runs(thread_id: str, request: Request)")
    && replacement.position === "replace",
);
assert(
  runPaginationReplacement?.insertion.includes("limit: int = Query(default=100, ge=1, le=100)")
    && runPaginationReplacement.insertion.includes("offset: int = Query(default=0, ge=0, le=10_000)")
    && runPaginationReplacement.insertion.includes("page_end = offset + limit")
    && runPaginationReplacement.insertion.includes("limit=page_end")
    && runPaginationReplacement.insertion.includes("records[offset:page_end]"),
  "DeerFlow run-list endpoint must apply bounded limit/offset pagination through the existing RunManager",
);
assert(
  patchManifest.agent?.anchor
    === "    # Coalesce every SystemMessage into a single leading one before the request\n"
    && patchManifest.agent?.insertion?.includes("WorkbenchToolScopeMiddleware(")
    && patchManifest.agent.insertion.includes("workbench_canvas_policy_from_runnable_config(config)")
    && patchManifest.agent.insertion.includes(
      "workbench_requested_artifact_kinds_from_runnable_config(config)",
    )
    && patchManifest.agent.insertion.includes(
      "workbench_knowledge_enabled_from_runnable_config(config)",
    ),
  "DeerFlow lead-agent patch must register Workbench scope after deferred filtering and freeze per-Run policies",
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
assert(
  toolScopeMiddlewareSource.includes(
    '_TOOL_CATALOG_METADATA_KEY = "workbench_tool_catalog_observation"',
  )
    && toolScopeMiddlewareSource.includes("def _stamp_ai_message(")
    && toolScopeMiddlewareSource.includes('message.model_copy(update={"response_metadata": response_metadata})')
    && toolScopeMiddlewareSource.includes("def _stamp_catalog_observation(")
    && toolScopeMiddlewareSource.includes("await handler(scoped_request)")
    && !toolScopeMiddlewareSource.includes("<workbench_tool_catalog_observation>"),
  "Workbench catalog evidence must stamp sync/async AIMessage response metadata after filtering",
);
assert(
  patchContractTestSource.includes(
    "test_catalog_observation_survives_message_reducer_and_checkpoint",
  )
    && patchContractTestSource.includes(
      "test_workbench_registration_after_deferred_filter_observes_effective_catalog",
    )
    && patchContractTestSource.includes("InMemorySaver()")
    && patchContractTestSource.includes('checkpoint["channel_values"]["messages"][-1]')
    && patchContractTestSource.includes("serialize_channel_values_for_api"),
  "Workbench catalog contract must prove real LangGraph reducer/checkpoint persistence",
);
const prdReferencePins = [
  [
    "/mnt/skills/public/requirement-doc-template/SKILL.md",
    "82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/structure.md",
    "7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70",
  ],
  [
    "/mnt/skills/public/requirement-doc-template/references/quality-standards.md",
    "ad2206958aee116654a657b1c979e7a0228aee1e080e2a289712bd7ad82b1c76",
  ],
  [
    "/mnt/skills/public/workbench/references/prd-runtime-result.schema.json",
    "bd2f09b81bf8538a33ccf9eb0942d364c23dedf071979dad991fe09812f9e747",
  ],
];
const prototypeReferencePins = [
  [
    "/mnt/skills/public/workbench/references/prototype-runtime-result.example.json",
    "e76e0c8b8c797a4941e31cc5067b80bb8106d4329b086ef743d6ad76ef958a99",
  ],
  [
    "/mnt/skills/public/workbench/references/runtime-result-contract.md",
    "a1849a25012bb9226fa5d576cdace96b1273efaf5f26e0593b6754c7dbeca206",
  ],
];
const workbenchReferencePins = [...prdReferencePins, ...prototypeReferencePins];
const canonicalPrdReferenceReader = {
  name: "read_file",
  group: "workbench",
  use: "deerflow_workbench_tools.prd_reference_tool:workbench_prd_reference_read",
};
assertDeepEqual(
  WORKBENCH_TRUSTED_TOOLS.filter((tool) => tool.name === canonicalPrdReferenceReader.name),
  [canonicalPrdReferenceReader],
  "the trusted tool contract must register exactly the restricted Workbench read_file implementation",
);
assert(
  prdReferenceToolSource.includes("class WorkbenchReferenceSpec:")
    && prdReferenceToolSource.includes("@dataclass(frozen=True)")
    && prdReferenceToolSource.includes("MappingProxyType({")
    && prdReferenceToolSource.includes('@tool("read_file", parse_docstring=True)')
    && prdReferenceToolSource.includes("def workbench_prd_reference_read(")
    && prdReferenceToolSource.includes("requested_artifact_kinds != list(reference.requested_artifact_kinds)")
    && prdReferenceToolSource.includes("reference = WORKBENCH_REFERENCE_FILES.get(path)")
    && prdReferenceToolSource.includes("content = reference.physical_path.read_bytes()")
    && prdReferenceToolSource.includes("actual_sha256 = hashlib.sha256(content).hexdigest()")
    && prdReferenceToolSource.includes('content.decode("utf-8", errors="strict")')
    && workbenchReferencePins.every(([virtualPath, digest]) => (
      prdReferenceToolSource.includes(`"${virtualPath}"`)
        && prdReferenceToolSource.includes(`"${virtualPath.replace(/^\/mnt/u, "/app")}"`)
        && prdReferenceToolSource.includes(`sha256="${digest}"`)
    )),
  "the Workbench reference reader must map only scoped pinned virtual paths to complete immutable image files",
);
const prdReferenceReaderSignature = /def workbench_prd_reference_read\(\n([\s\S]*?)\n\) -> str:/u
  .exec(prdReferenceToolSource)?.[1];
assert(
  prdReferenceReaderSignature?.includes("runtime: Runtime")
    && prdReferenceReaderSignature.includes("description: str")
    && prdReferenceReaderSignature.includes("path: WorkbenchReferencePath")
    && !prdReferenceReaderSignature.includes("start_line")
    && !prdReferenceReaderSignature.includes("end_line")
    && !prdReferenceReaderSignature.includes("file_path"),
  "the Workbench reference reader schema must expose one complete whitelisted path without range or alias parameters",
);
assert(
  prdReferenceToolTestSource.includes(
    "test_schema_is_named_read_file_and_allows_only_six_complete_paths",
  )
    && prdReferenceToolTestSource.includes(
      "test_reads_each_exact_authorized_static_path_and_returns_complete_utf8_unchanged",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_aliases_traversal_and_non_path_alias_parameters",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_missing_malformed_unauthorized_and_mixed_scope",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_content_that_does_not_match_the_pinned_sha256",
    )
    && prdReferenceToolTestSource.includes(
      "test_rejects_non_utf8_after_the_pinned_byte_hash_matches",
    ),
  "the Workbench reference reader contract must cover schema, scope, traversal, integrity, and UTF-8 failures",
);
assert(
  prototypeNormalizerSource.includes("def normalize_prototype_layout_aliases(")
    && prototypeNormalizerSource.includes("def normalize_runtime_result_prototype_layout_aliases(")
    && prototypeNormalizerSource.includes('"space-between": "spaceBetween"')
    && prototypeNormalizerSource.includes('"space-around": "spaceAround"')
    && prototypeNormalizerSource.includes('"mount": "enter"')
    && prototypeNormalizerSource.includes('node["maxLines"] = None')
    && prototypeNormalizerSource.includes('del node["textStyle"]')
    && prototypeNormalizerSource.includes("_PROTOTYPE_COLLECTION_DEFAULTS")
    && prototypeNormalizerSource.includes("copy.deepcopy"),
  "the Prototype runtime normalizer must repair only the known compatibility aliases on copied values",
);
assert(
  prototypeNormalizerTestSource.includes(
    "test_maps_supported_layout_aliases_without_mutating_the_artifact",
  )
    && prototypeNormalizerTestSource.includes(
      "test_repairs_observed_prototype_result_compatibility_gaps",
    )
    && prototypeNormalizerTestSource.includes(
      "test_preserves_existing_invalid_values_but_removes_unsupported_text_style",
    )
    && prototypeNormalizerTestSource.includes("test_prefixes_repairs_for_a_runtime_result")
    && prototypeNormalizerTestSource.includes("test_leaves_non_prototype_artifacts_unchanged"),
  "the Prototype runtime normalizer contract must cover aliases, result paths, and non-Prototype input",
);
assert(
  toolScopeMiddlewareSource.includes('self._prd_gate_enabled = normalized_kinds == ["prd"]')
    && toolScopeMiddlewareSource.includes('self._prototype_reference_enabled = normalized_kinds == ["prototype"]')
    && prdReferencePins.every(([path, digest]) => (
      toolScopeMiddlewareSource.includes(`"${path}"`)
        && toolScopeMiddlewareSource.includes(`"${digest}"`)
    ))
    && prototypeReferencePins.every(([path, digest]) => (
      toolScopeMiddlewareSource.includes(`"${path}"`)
        && toolScopeMiddlewareSource.includes(`"${digest}"`)
    ))
    && toolScopeMiddlewareSource.includes('hashlib.sha256(content.encode("utf-8")).hexdigest()')
    && toolScopeMiddlewareSource.includes("WORKBENCH_PRD_REFERENCE_CONTENT_MISMATCH")
    && toolScopeMiddlewareSource.includes("WORKBENCH_PROTOTYPE_REFERENCE_CONTENT_MISMATCH")
    && toolScopeMiddlewareSource.includes("PROTOTYPE_STAGE_SEQUENCE = (")
    && ["design-system", "mapping-components", "creating-flows", "generating-ui"].every(
      (stage) => toolScopeMiddlewareSource.includes(`\"${stage}\"`),
    )
    && toolScopeMiddlewareSource.includes("def _prototype_stage_preflight(")
    && toolScopeMiddlewareSource.includes("WORKBENCH_PROTOTYPE_STAGE_ORDER_INVALID")
    && toolScopeMiddlewareSource.includes("WORKBENCH_PROTOTYPE_STAGE_FAMILY_INVALID"),
  "Workbench reference gates must bind exact kind-scoped Runtime paths and SHA-256 pins",
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
  patchContractTestSource.includes(
    "test_prototype_stage_gate_recovers_from_first_generating_ui_skip",
  )
    && patchContractTestSource.includes(
      "test_prototype_stage_gate_allows_only_the_full_ordered_sequence",
    )
    && patchContractTestSource.includes(
      "test_async_prototype_stage_gate_recovers_and_completes_ordered_sequence",
    )
    && patchContractTestSource.includes("test_prototype_stage_policy_is_injected_once_for_exact_scope"),
  "DeerFlow Prototype contract must cover recoverable stage correction, ordered sync/async execution, and policy injection",
);
assert(
  patchRequestContextTestSource.includes("test_only_an_authenticated_internal_caller_can_deliver_workbench_channels")
    && patchRequestContextTestSource.includes("test_untrusted_context_is_fail_closed_and_persistence_config_is_redacted")
    && patchRequestContextTestSource.includes("test_knowledge_visibility_requires_the_exact_true_flag_and_capability")
    && patchRequestContextTestSource.includes("test_malformed_scope_does_not_create_a_runtime_secret_channel")
    && patchRequestContextTestSource.includes("test_exact_trusted_prd_scope_receives_the_named_recursion_budget")
    && patchRequestContextTestSource.includes(
      "test_exact_trusted_prototype_and_code_scopes_receive_the_named_recursion_budget",
    )
    && patchRequestContextTestSource.includes("test_non_exact_malformed_untrusted_and_forged_fields_keep_default_budget"),
  "DeerFlow request-context contract must cover caller auth, redaction, and malformed scope",
);
assert(
  patchRequestContextTestSource.includes("test_run_list_honors_bounded_offset_pages_beyond_default_cap")
    && patchRequestContextTestSource.includes("offset=100")
    && patchRequestContextTestSource.includes("offset=10_000")
    && patchRequestContextTestSource.includes('"limit": 200')
    && patchRequestContextTestSource.includes('"limit": 10_100'),
  "DeerFlow request-context contract must exercise paginated run recovery beyond the default 100-run page",
);
assert(
  patchRequestContextTestSource.includes("test_real_run_manager_deduplicates_store_rows_without_underfilling")
    && patchRequestContextTestSource.includes("class RecordingMemoryRunStore(MemoryRunStore)")
    && patchRequestContextTestSource.includes("self.list_limits.append(limit)")
    && patchRequestContextTestSource.includes("self.assertEqual(store.list_limits, [5])")
    && patchRequestContextTestSource.includes('[live.run_id, "stored-3", "stored-2", "stored-1"]'),
  "DeerFlow source-patch contract must dynamically prove real RunManager de-duplication without page under-fill",
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
    && normalizedWorkbenchSkillSource.includes("only a non-PRD Run may request input")
    && normalizedWorkbenchSkillSource.includes("cannot use clarification or end early")
    && !normalizedWorkbenchSkillSource.includes("otherwise request input")
    && !normalizedWorkbenchSkillSource.includes("or use clarification where"),
  "Workbench skill must complete PRDs without the unsupported clarification path",
);
assert(
  normalizedWorkbenchSkillSource.includes("request-scoped")
    && normalizedWorkbenchSkillSource.includes("prototype-runtime-result.example.json")
    && normalizedWorkbenchSkillSource.includes("runtime-result-contract.md")
    && normalizedWorkbenchSkillSource.includes("never use `read_file` on")
    && normalizedWorkbenchSkillSource.includes("`/mnt/skills/public/workbench/SKILL.md`")
    && !normalizedWorkbenchSkillSource.includes("configured `read_file` capability in this Workbench Runtime is a PRD-only reference reader"),
  "Workbench skill must describe the exact Prototype reference scope without the former PRD-only contradiction",
);
assert(
  toolScopeMiddlewareSource.includes('READ_FILE_TOOL_NAME = "read_file"')
    && toolScopeMiddlewareSource.includes("and not self._prototype_reference_enabled")
    && toolScopeMiddlewareSource.includes(
      '_REFERENCE_BLOCK_CODE = "WORKBENCH_REFERENCE_TOOL_NOT_AUTHORIZED"',
    )
    && toolScopeMiddlewareSource.includes("def _prototype_reference_preflight(")
    && toolScopeMiddlewareSource.includes("def _prototype_reference_postflight("),
  "DeerFlow middleware must expose only exact kind-scoped PRD and Prototype references",
);
const taskToolPatch = patchManifest.additionalSources.find(
  (entry) => entry.path === "deerflow/tools/builtins/task_tool.py",
);
const taskToolPatchText = JSON.stringify(taskToolPatch?.replacements ?? []);
assert(
  taskToolPatchText.includes("workbench_knowledge_retrieve")
    && taskToolPatchText.includes("workbench_runtime_result_submit")
    && taskToolPatchText.includes("read_file")
    && taskToolPatchText.includes("_workbench_parent_run_tool_names")
    && taskToolPatchText.includes('if getattr(tool, \\"name\\", None) not in _workbench_parent_run_tool_names'),
  "DeerFlow subagents must remove Knowledge and every parent-Run publication, PRD reference, and Canvas tool",
);
assert(
  patchContractTestSource.includes("test_async_authorized_knowledge_is_visible_and_executes")
    && patchContractTestSource.includes("test_concurrent_opposite_knowledge_scopes_do_not_leak")
    && patchContractTestSource.includes("test_real_subagent_executor_removes_parent_run_tools")
    && patchContractTestSource.includes('FakeTool("workbench_runtime_result_submit")')
    && patchContractTestSource.includes('patch.object(task_module, "SubagentExecutor", FakeExecutor)')
    && patchContractTestSource.includes('[tool.name for tool in captured_executor_kwargs["tools"]]'),
  "DeerFlow source-patch contract must dynamically prove async Knowledge isolation and subagent executor filtering",
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
  "WORKBENCH_RUNTIME_CORE_TOOLS_IMAGE_PROBE_FAILED",
  "configured_tools",
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
  ["SKILL.md", "82ec80d5b8d68916b2fb9259e30db9e0982645ae96e6d189a9d1dd3daf2baf0f"],
  ["agents/openai.yaml", "f93eee46ee2b76146c7d2b212f6c26da3c16b28d566eac0a3158c92f9425afc0"],
  ["assets/requirement-template.docx", "3070777f5c624be731bd264f72955ca4d15d5ac68d20867318ce8c0081789ebf"],
  ["references/quality-standards.md", "ad2206958aee116654a657b1c979e7a0228aee1e080e2a289712bd7ad82b1c76"],
  ["references/structure.md", "7952eb98fadbbd992f1bdbd227953aacbcbcdea7fdef1f758987750a9ac5bf70"],
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

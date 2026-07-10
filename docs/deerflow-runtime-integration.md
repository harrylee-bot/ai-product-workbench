# DeerFlow Runtime Integration

Date: 2026-06-26

## Boundary

AI Product Workbench treats DeerFlow 2.0 as an external first-class runtime.

The Nest backend is responsible for:

- validating user/conversation access;
- creating the user message and local run record;
- creating or reusing a DeerFlow thread for the current conversation;
- forwarding context to DeerFlow;
- translating DeerFlow stream events into the existing workbench SSE stream;
- storing the assistant message and final action returned by DeerFlow.

The Nest backend must not reimplement DeerFlow's graph, planner, coding node, or workflow decisions.

## Runtime URLs

DeerFlow 2.0 Gateway exposes the LangGraph-compatible thread/run APIs under `/api`.
AI Product Workbench uses the Gateway surface by default so service-to-service calls, uploads,
artifacts, custom agents, and skills all share the same runtime boundary.

- LangGraph-compatible API: `DEERFLOW_LANGGRAPH_URL`, default `http://localhost:8001/api`
- Gateway API: `DEERFLOW_GATEWAY_URL`, default `http://localhost:8001`

Direct LangGraph Server on `http://localhost:2024` is still useful for LangGraph Studio or
DeerFlow debugging, but it is not the Workbench default path.

## Required Env

```env
DEERFLOW_ENABLED=true
DEERFLOW_GATEWAY_URL=http://localhost:8001
DEERFLOW_LANGGRAPH_URL=http://localhost:8001/api
DEERFLOW_ASSISTANT_ID=lead_agent
DEERFLOW_AGENT_NAME=ai-product-workbench-lead
DEERFLOW_MODEL_NAME=workbench-claude
DEERFLOW_STREAM_MODE=messages,values
DEERFLOW_INTERNAL_AUTH_TOKEN=<same strong token as DeerFlow DEER_FLOW_INTERNAL_AUTH_TOKEN>
DEERFLOW_SHARED_AGENT_DIR=<DeerFlow .deer-flow/agents host path>
DEERFLOW_SHARED_SKILL_DIR=<DeerFlow skills/custom host path>
AICHAT_MODEL_IDLE_TIMEOUT_MS=600000
AICHAT_ARTIFACT_REPAIR_ATTEMPTS=2
DEERFLOW_UPLOADS_ENABLED=true
DEERFLOW_ARTIFACT_MAX_INLINE_BYTES=2000000
```

`DEERFLOW_AGENT_NAME` should be enabled after the DeerFlow custom agent has been installed. Leave it empty if the DeerFlow instance does not have the agent yet.

## Thread Binding

`deerflow_thread_bindings` maps one local conversation to one DeerFlow thread.
This keeps multi-turn context inside DeerFlow while keeping our database as the app shell source for conversations, messages, and run logs.

Workbench sends `X-DeerFlow-Owner-User-Id` on LangGraph and Gateway calls. If the DeerFlow Gateway enables internal authentication, set Workbench `DEERFLOW_INTERNAL_AUTH_TOKEN` to the same value as DeerFlow `DEER_FLOW_INTERNAL_AUTH_TOKEN` so DeerFlow honors that owner scope. This prevents a new Workbench conversation from inheriting another conversation's user memory while still allowing the same conversation to reuse its thread.

Production deployment fails fast when DeerFlow is enabled and this token is empty or weak. Do not bypass the check: without a trusted owner header, DeerFlow falls back to its default user bucket and can mix long-term memory between Workbench users.

When `DEERFLOW_AGENT_NAME` is set, production also requires `DEERFLOW_SHARED_AGENT_DIR`. The API deploy copies the tracked `config.yaml` and `SOUL.md` into DeerFlow's shared agent directory so every isolated Workbench user can load the same runtime agent. `DEERFLOW_SHARED_SKILL_DIR` keeps the tracked Workbench skill files synchronized with DeerFlow's shared custom-skill directory.

The DeerFlow run stream has no wall-clock timeout. `AICHAT_MODEL_IDLE_TIMEOUT_MS` is only an inactivity limit: every DeerFlow event resets it, while a run that produces no event for the configured interval fails and asks the user to retry. No draft fallback is generated.

After deterministic artifact QA, `AICHAT_ARTIFACT_REPAIR_ATTEMPTS` controls how many complete repair turns run in the same DeerFlow thread. Each repair receives the concrete QA issues and must replace the design state, PRD, PrototypeSpec, and HTML as a consistent set. Nothing is persisted until the quality gate passes.

## Gateway Owner Scope Patch

The Workbench sends a trusted owner header for thread creation, memory, uploads, and artifact reads. Apply the tracked DeerFlow patch so the Gateway artifact route resolves files from the same isolated user directory as the run:

```bash
DEERFLOW_SOURCE_DIR=/path/to/deer-flow npm run deerflow:patch
```

Rebuild and restart the DeerFlow Gateway after applying it. The patch is idempotent and fails closed if the target DeerFlow source no longer matches, which forces an explicit review during future DeerFlow upgrades.

When the full DeerFlow build cannot reach its base-image registry, build the tracked incremental image from the already-installed Gateway image:

```bash
docker build \
  --file /path/to/ai-product-workbench/integrations/deerflow/Dockerfile.owner-scope-patch \
  --tag deer-flow-gateway:owner-scope \
  /path/to/deer-flow
```

## Context And Compaction

Context retention and compaction belong to DeerFlow, not to a custom NestJS summarizer.

- Same Workbench conversation -> same DeerFlow thread via `deerflow_thread_bindings`.
- New Workbench conversation -> new DeerFlow thread, so it must not inherit previous chat state.
- Long-context compression uses DeerFlow's built-in `DeerFlowSummarizationMiddleware`, which wraps LangChain's `SummarizationMiddleware`.
- DeerFlow memory and dynamic context injection are handled by `DynamicContextMiddleware` and the DeerFlow memory system.
- Workbench only forwards conversation/runtime context and the current turn; it must not reimplement message trimming, summary generation, or Codex/DeerFlow context windows in NestJS.

Required DeerFlow-side `config.yaml` baseline:

```yaml
summarization:
  enabled: true
  model_name: null
  trigger:
    - type: tokens
      value: 32000
  keep:
    type: messages
    value: 10
  trim_tokens_to_summarize: 15564
  preserve_recent_skill_count: 5
  preserve_recent_skill_tokens: 25000
  preserve_recent_skill_tokens_per_skill: 5000
  skill_file_read_tool_names:
    - read_file
    - read
    - view
    - cat
```

This is the open-source path shipped by DeerFlow/LangChain. If context policy needs tuning, update DeerFlow `config.yaml` and restart DeerFlow Gateway; do not add another summarization service in Workbench.

## Final Action

The prompt asks DeerFlow to end with a fenced JSON block:

````text
```ai_product_workbench_final_action
{"type":"answer","message":"...","intent":"general_question"}
```
````

Currently supported action types are:

- `answer`
- `review_prd`
- `review_prototype`
- `ask_clarification`
- `download_export`

Unsupported or missing final action blocks degrade to `answer` with the visible assistant text.

## Gateway Uploads

When a user attaches files, the backend:

- validates local file access through `FileAssetService`;
- uploads original files to `POST /api/threads/{thread_id}/uploads`;
- forwards DeerFlow virtual paths and markdown conversion paths in the LangGraph turn context.

Agents should read uploaded files through `deerFlowUploads[].deerFlowFile.virtualPath` or `markdownVirtualPath`, not through local app storage paths.

## Gateway Artifacts

DeerFlow should include generated output paths in the final action:

```json
{
  "type": "review_prototype",
  "message": "请查看生成的原型。",
  "intent": "generate_prototype",
  "artifacts": [
    {
      "kind": "prototype_html",
      "title": "签到活动原型",
      "path": "mnt/user-data/outputs/index.html",
      "contentType": "text/html"
    }
  ]
}
```

The backend fetches these paths through `GET /api/threads/{thread_id}/artifacts/{path}` and stores small text/HTML/JSON artifacts inline in the run result. Large or binary artifacts are recorded by URL/path only.

## DeerFlow Assets

This repository ships DeerFlow-side runtime assets under `integrations/deerflow/`:

- `agents/ai-product-workbench-lead`: custom agent config and `SOUL.md`
- `skills/ai-product-workbench`: Workbench skill and final action contract

Install or update them on a running DeerFlow instance:

```bash
npm run deerflow:bootstrap -- --gateway-url http://localhost:8001 --langgraph-url http://localhost:8001/api
```

Validate locally without network calls:

```bash
npm run deerflow:bootstrap -- --dry-run
```

After installation, set:

```env
DEERFLOW_AGENT_NAME=ai-product-workbench-lead
```

## Coding/Prototype Execution

Coding and prototype work belongs inside DeerFlow's graph, sandbox, tools, and sub-agent system. The Workbench backend does not ship or invoke a direct Codex adapter. It only streams DeerFlow events and applies the final action returned by DeerFlow.

## References

- DeerFlow README: `https://github.com/bytedance/deer-flow`
- LangGraph threads: `https://mintlify.wiki/bytedance/deer-flow/api/langgraph/threads.md`
- LangGraph streaming: `https://mintlify.wiki/bytedance/deer-flow/api/langgraph/streaming.md`
- Gateway overview: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/overview.md`
- Gateway uploads: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/uploads.md`
- Gateway artifacts: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/artifacts.md`
- Custom agents: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/agents.md`
- Skills: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/skills.md`
- Sub-agents: `https://mintlify.wiki/bytedance/deer-flow/concepts/sub-agents.md`
- Sandbox tools: `https://mintlify.wiki/bytedance/deer-flow/api/tools/sandbox.md`

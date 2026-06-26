# DeerFlow Runtime Integration

Date: 2026-06-26

## Boundary

AI Product Workbench treats DeerFlow 2.0 as an external first-class runtime.

The Nest backend is responsible for:

- validating user/project/conversation access;
- creating the user message and local run record;
- creating or reusing a DeerFlow thread for the current conversation;
- forwarding context to DeerFlow;
- translating DeerFlow stream events into the existing workbench SSE stream;
- storing the assistant message and final action returned by DeerFlow.

The Nest backend must not reimplement DeerFlow's graph, planner, coding node, or workflow decisions.

## Runtime URLs

Official DeerFlow 2.0 docs separate the surfaces:

- LangGraph server: `DEERFLOW_LANGGRAPH_URL`, default `http://localhost:2024`
- Gateway API: `DEERFLOW_GATEWAY_URL`, default `http://localhost:8001`

The integration uses LangGraph thread/run/stream plus Gateway upload/artifact access.

## Required Env

```env
DEERFLOW_ENABLED=true
DEERFLOW_LANGGRAPH_URL=http://localhost:2024
DEERFLOW_GATEWAY_URL=http://localhost:8001
DEERFLOW_ASSISTANT_ID=lead_agent
DEERFLOW_AGENT_NAME=ai-product-workbench-lead
DEERFLOW_STREAM_MODE=messages-tuple
DEERFLOW_UPLOADS_ENABLED=true
DEERFLOW_ARTIFACT_MAX_INLINE_BYTES=2000000
```

`DEERFLOW_AGENT_NAME` should be enabled after the DeerFlow custom agent has been installed. Leave it empty if the DeerFlow instance does not have the agent yet.

## Thread Binding

`deerflow_thread_bindings` maps one local conversation to one DeerFlow thread.
This keeps multi-turn context inside DeerFlow while keeping our database as the app shell source for projects, messages, and run logs.

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
- `skills/ai-product-workbench`: Workbench skill, final action contract, Codex execution-node procedure
- `skills/ai-product-workbench/scripts/run_codex_node.py`: process-exit based Codex execution wrapper

Install or update them on a running DeerFlow instance:

```bash
npm run deerflow:bootstrap -- --gateway-url http://localhost:8001 --langgraph-url http://localhost:2024
```

Validate locally without network calls:

```bash
npm run deerflow:bootstrap -- --dry-run
```

After installation, set:

```env
DEERFLOW_AGENT_NAME=ai-product-workbench-lead
```

## Codex Node

Codex runs inside DeerFlow as a coding/prototype execution node. DeerFlow decides when to use it, normally via a `task()` sub-agent. The bundled script invokes `codex exec` and writes:

- `codex-prompt.md`
- `codex-stdout.log`
- `codex-stderr.log`
- `codex-last-message.md`
- `codex-node-manifest.json`

The completion signal is the Codex process exit and manifest status. The backend never polls output files to guess whether Codex has finished.

Useful DeerFlow sandbox environment variables:

```env
CODEX_COMMAND=codex
CODEX_NODE_MODEL=
CODEX_NODE_SANDBOX=workspace-write
CODEX_NODE_APPROVAL_POLICY=never
CODEX_NODE_COMMAND_TEMPLATE=
```

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

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

The first integration uses LangGraph thread/run/stream. Gateway upload/artifact sync is the next step.

## Required Env

```env
DEERFLOW_ENABLED=true
DEERFLOW_LANGGRAPH_URL=http://localhost:2024
DEERFLOW_GATEWAY_URL=http://localhost:8001
DEERFLOW_ASSISTANT_ID=lead_agent
DEERFLOW_STREAM_MODE=messages-tuple
```

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

## References

- DeerFlow README: `https://github.com/bytedance/deer-flow`
- LangGraph threads: `https://mintlify.wiki/bytedance/deer-flow/api/langgraph/threads.md`
- LangGraph streaming: `https://mintlify.wiki/bytedance/deer-flow/api/langgraph/streaming.md`
- Gateway overview: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/overview.md`
- Gateway uploads: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/uploads.md`
- Gateway artifacts: `https://mintlify.wiki/bytedance/deer-flow/api/gateway/artifacts.md`

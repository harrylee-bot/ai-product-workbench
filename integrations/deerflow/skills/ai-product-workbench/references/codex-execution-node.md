# Codex Execution Node

Codex is used only for concrete coding/prototype execution after DeerFlow has decided that code or prototype artifacts are needed.

## When To Use

Use the Codex node for:

- generating or revising HTML/CSS/JS prototypes;
- editing a sandbox workspace;
- producing deterministic files under `/mnt/user-data/outputs/`;
- running checks that are part of a coding task.

Do not use Codex for:

- greetings or general questions;
- intent classification;
- simple PRD drafting that DeerFlow can do directly;
- deciding the overall product workflow.

## Sub-Agent Pattern

Delegate execution through DeerFlow's `task()` tool:

```python
task(
    description="Generate prototype HTML with Codex",
    prompt="Use the ai-product-workbench Codex execution node. Create /mnt/user-data/workspace/codex-request.json, then run the bundled run_codex_node.py script. Write final artifacts under /mnt/user-data/outputs/checkin-prototype.",
    subagent_type="bash",
    max_turns=20
)
```

The sub-agent should write a request file:

```json
{
  "task": "generate_prototype_html",
  "prompt": "Generate a polished mobile HTML prototype for a check-in campaign.",
  "inputs": {
    "productDesignState": {},
    "prototypeSpec": {},
    "uploads": []
  },
  "expectedOutputs": [
    "/mnt/user-data/outputs/checkin-prototype/index.html"
  ],
  "acceptanceCriteria": [
    "No external network dependencies",
    "All files are under /mnt/user-data/outputs/checkin-prototype",
    "Prototype is directly previewable as HTML"
  ]
}
```

## Script Invocation

Prefer the bundled script:

```bash
python /path/to/ai-product-workbench/scripts/run_codex_node.py \
  --request /mnt/user-data/workspace/codex-request.json \
  --workspace /mnt/user-data/workspace \
  --output-dir /mnt/user-data/outputs/checkin-prototype
```

If the installed skill resource path is not obvious, inspect the DeerFlow skill directory or copy the script content into `/mnt/user-data/workspace/run_codex_node.py`.

## Completion Rule

The Codex node is complete when the Codex process exits and `codex-node-manifest.json` is written. Do not infer completion from output-file quiescence.

Manifest shape:

```json
{
  "status": "succeeded | failed | timeout | dry_run",
  "request": {},
  "workspace": "/mnt/user-data/workspace",
  "outputDir": "/mnt/user-data/outputs/checkin-prototype",
  "promptFile": "/mnt/user-data/outputs/checkin-prototype/codex-prompt.md",
  "stdoutFile": "/mnt/user-data/outputs/checkin-prototype/codex-stdout.log",
  "stderrFile": "/mnt/user-data/outputs/checkin-prototype/codex-stderr.log",
  "lastMessageFile": "/mnt/user-data/outputs/checkin-prototype/codex-last-message.md",
  "exitCode": 0,
  "durationMs": 1000
}
```

After the manifest is available, inspect generated files and include final artifact paths in the Workbench final action.

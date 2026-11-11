# Agent Instructions

- In this project, "知识库", "同步到知识库", and "同步到项目" refer to this repository's local `knowledge-vault`, project database knowledge base, and local `storage` archive.
- Do not sync project conversation content, source assets, or generated knowledge to any external knowledge base unless the user explicitly names that external destination and provides the needed authorization or link.
- For large source assets, keep the original file under `storage/` and write a structured Markdown index under `knowledge-vault/` instead of committing heavy binaries into the public Quartz vault.
- Before operating the production requirement-pool/APITable deployment, read `docs/runbooks/apitable-production-operations.md`. Resolve the live domain first and verify the remote hostname and the configured APITable installation directory before changing anything; never reuse an IP only because it appears in an old handoff or conversation.
- The current requirement-pool origin is documented as `REDACTED_REQUIREMENT_POOL_ORIGIN_IP` (verified 2026-08-05). `REDACTED_HISTORICAL_ORIGIN_IP` is a stale historical address and must not be used for APITable operations unless DNS and the runbook are deliberately updated after a migration.
- Never store SSH private keys, passwords, session cookies, database credentials, API keys, or other production secrets in this repository. Use the local SSH configuration and the server-side APITable environment file without printing secret values.
- The active application version is `1.0.0`. Keep the current audit and outstanding work in `docs/audit/1.0.0.md`; update that report instead of creating dated audit, handoff, or test-result documents.
- Store only the current audit's local test output under `output/audit/1.0.0/`. Architecture documents describe contracts and procedures; execution results belong in the active audit report.
- Preserve executable tests, database migrations, protocol versions, and source knowledge assets when cleaning audit records. Local file cleanup does not withdraw published database knowledge releases.

# Agent Instructions

- In this project, "知识库", "同步到知识库", and "同步到项目" refer to this repository's local `knowledge-vault`, project database knowledge base, and local `storage` archive.
- Do not sync project conversation content, source assets, or generated knowledge to any external knowledge base unless the user explicitly names that external destination and provides the needed authorization or link.
- For large source assets, keep the original file under `storage/` and write a structured Markdown index under `knowledge-vault/` instead of committing heavy binaries into the public Quartz vault.
- Before operating the production requirement-pool/APITable deployment, read `docs/runbooks/apitable-production-operations.md`. Resolve the live domain first and verify the remote hostname and `/opt/apitable` before changing anything; never reuse an IP only because it appears in an old handoff or conversation.
- The current requirement-pool origin is documented as `45.207.206.119` (verified 2026-08-05). `8.130.16.170` is a stale historical address and must not be used for APITable operations unless DNS and the runbook are deliberately updated after a migration.
- Never store SSH private keys, passwords, session cookies, database credentials, API keys, or other production secrets in this repository. Use the local SSH configuration and the server-side `/opt/apitable/.env` without printing secret values.

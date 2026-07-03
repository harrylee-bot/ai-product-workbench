# Agent Instructions

- In this project, "知识库", "同步到知识库", and "同步到项目" refer to this repository's local `knowledge-vault`, project database knowledge base, and local `storage` archive.
- Do not sync project conversation content, source assets, or generated knowledge to Feishu/Lark or any other external knowledge base unless the user explicitly names that external destination and provides the needed authorization or link.
- For large source assets, keep the original file under `storage/` and write a structured Markdown index under `knowledge-vault/` instead of committing heavy binaries into the public Quartz vault.

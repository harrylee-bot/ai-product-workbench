#!/usr/bin/env python3
import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Codex as a DeerFlow coding/prototype execution node.")
    parser.add_argument("--request", required=True, help="Path to a JSON request file.")
    parser.add_argument("--workspace", default=None, help="Workspace directory for Codex.")
    parser.add_argument("--output-dir", required=True, help="Directory for prompt, logs, manifest, and artifacts.")
    parser.add_argument("--codex-command", default=None, help="Codex executable or command prefix.")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    request_path = Path(args.request)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    with request_path.open("r", encoding="utf-8") as handle:
        request = json.load(handle)

    workspace = Path(args.workspace or request.get("workspace") or "/mnt/user-data/workspace")
    workspace.mkdir(parents=True, exist_ok=True)

    prompt_file = output_dir / "codex-prompt.md"
    stdout_file = output_dir / "codex-stdout.log"
    stderr_file = output_dir / "codex-stderr.log"
    last_message_file = output_dir / "codex-last-message.md"
    manifest_file = output_dir / "codex-node-manifest.json"

    prompt = build_prompt(request, output_dir)
    prompt_file.write_text(prompt, encoding="utf-8")

    started = time.time()
    manifest = {
        "status": "dry_run" if args.dry_run else "running",
        "request": request,
        "workspace": str(workspace),
        "outputDir": str(output_dir),
        "promptFile": str(prompt_file),
        "stdoutFile": str(stdout_file),
        "stderrFile": str(stderr_file),
        "lastMessageFile": str(last_message_file),
        "exitCode": None,
        "durationMs": None,
    }

    if args.dry_run:
        write_manifest(manifest_file, manifest, started)
        return 0

    command = build_command(args, workspace, last_message_file)
    manifest["command"] = command

    try:
        completed = subprocess.run(
            command,
            input=prompt,
            text=True,
            cwd=str(workspace),
            capture_output=True,
            timeout=args.timeout_seconds,
            check=False,
        )
        stdout_file.write_text(completed.stdout or "", encoding="utf-8")
        stderr_file.write_text(completed.stderr or "", encoding="utf-8")
        manifest["exitCode"] = completed.returncode
        manifest["status"] = "succeeded" if completed.returncode == 0 else "failed"
        write_manifest(manifest_file, manifest, started)
        return completed.returncode
    except subprocess.TimeoutExpired as error:
        stdout_file.write_text(error.stdout or "", encoding="utf-8")
        stderr_file.write_text(error.stderr or "", encoding="utf-8")
        manifest["status"] = "timeout"
        manifest["errorMessage"] = f"Codex timed out after {args.timeout_seconds} seconds"
        write_manifest(manifest_file, manifest, started)
        return 124
    except FileNotFoundError as error:
        stderr_file.write_text(str(error), encoding="utf-8")
        manifest["status"] = "failed"
        manifest["errorMessage"] = str(error)
        write_manifest(manifest_file, manifest, started)
        return 127


def build_prompt(request: dict, output_dir: Path) -> str:
    sections = [
        "# Codex Execution Node",
        "",
        "You are Codex running inside DeerFlow for AI Product Workbench.",
        "DeerFlow has already decided this is a concrete coding or prototype execution task.",
        "Write all user-visible artifacts under the requested output directory.",
        "",
        f"Output directory: `{output_dir}`",
        "",
        "## Request JSON",
        "```json",
        json.dumps(request, ensure_ascii=False, indent=2),
        "```",
        "",
        "## Rules",
        "- Do not ask NestJS or AI Product Workbench to decide the workflow.",
        "- Do not write outside the workspace or output directory.",
        "- Prefer a directly previewable `index.html` for prototype tasks.",
        "- Run lightweight checks when available.",
        "- End with a short summary of generated files.",
    ]
    return "\n".join(sections)


def build_command(args: argparse.Namespace, workspace: Path, last_message_file: Path) -> list[str]:
    template = os.getenv("CODEX_NODE_COMMAND_TEMPLATE")
    if template:
        rendered = template.format(
            workspace=str(workspace),
            output_dir=str(Path(args.output_dir)),
            last_message_file=str(last_message_file),
        )
        return shlex.split(rendered)

    command_prefix = args.codex_command or os.getenv("CODEX_NODE_COMMAND") or os.getenv("CODEX_COMMAND") or "codex"
    command = shlex.split(command_prefix)
    sandbox = os.getenv("CODEX_NODE_SANDBOX") or os.getenv("CODEX_SANDBOX") or "workspace-write"
    approval = os.getenv("CODEX_NODE_APPROVAL_POLICY") or "never"
    model = os.getenv("CODEX_NODE_MODEL") or os.getenv("CODEX_MODEL")

    command.extend(["--ask-for-approval", approval])
    command.append("exec")
    if model:
        command.extend(["--model", model])
    command.extend([
        "--cd",
        str(workspace),
        "--sandbox",
        sandbox,
        "--skip-git-repo-check",
        "--output-last-message",
        str(last_message_file),
        "-",
    ])
    return command


def write_manifest(path: Path, manifest: dict, started: float) -> None:
    manifest["durationMs"] = int((time.time() - started) * 1000)
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())

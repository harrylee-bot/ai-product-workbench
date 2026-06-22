#!/usr/bin/env bash
set -euo pipefail

DEST="${CODEX_HOME:-/root/.codex}/skills"
SOURCE_DIR="${SOURCE_DIR:-/opt/ai-product-workbench/agent-skills/obsidian-skills}"
REPO_URL="${OBSIDIAN_SKILLS_REPO:-https://github.com/kepano/obsidian-skills.git}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DEST" "$(dirname "$SOURCE_DIR")"

git clone --depth 1 "$REPO_URL" "$TMP_DIR/obsidian-skills"
rm -rf "$SOURCE_DIR"
cp -R "$TMP_DIR/obsidian-skills" "$SOURCE_DIR"

for skill in obsidian-markdown obsidian-bases json-canvas obsidian-cli defuddle; do
  rm -rf "$DEST/$skill"
  cp -R "$TMP_DIR/obsidian-skills/skills/$skill" "$DEST/$skill"
done

echo "Installed Obsidian skills to $DEST"
find "$DEST" -maxdepth 2 -name SKILL.md | sort

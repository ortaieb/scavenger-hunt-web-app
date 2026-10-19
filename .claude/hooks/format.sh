#!/usr/bin/env bash
# PostToolUse (Edit|Write): format the file Claude just touched.
# Non-blocking by design: always exits 0, stays silent, skips formatters that aren't installed.
set -u

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
[ -f "$FILE" ] || exit 0

PROJECT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
# Only touch files inside this project
case "$FILE" in
  "$PROJECT"/*) ;;
  *) exit 0 ;;
esac

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.mdx|*.yml|*.yaml)
    PRETTIER="$PROJECT/node_modules/.bin/prettier"
    [ -x "$PRETTIER" ] && "$PRETTIER" --write --log-level silent "$FILE" >/dev/null 2>&1
    ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$FILE" >/dev/null 2>&1
    ;;
  *.rs)
    # rustfmt picks up edition/options from the nearest rustfmt.toml
    command -v rustfmt >/dev/null 2>&1 && rustfmt "$FILE" >/dev/null 2>&1
    ;;
  *.py)
    command -v ruff >/dev/null 2>&1 && ruff format --quiet "$FILE" >/dev/null 2>&1
    ;;
esac

exit 0

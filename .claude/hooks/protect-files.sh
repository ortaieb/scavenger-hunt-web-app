#!/usr/bin/env bash
# PreToolUse (Edit|Write): block direct edits to secrets, lockfiles and VCS internals.
# Exit 2 = block; stderr is fed back to Claude so it can change approach.
set -u

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
FILE="${FILE//\\//}"
BASE=$(basename "$FILE")

case "$BASE" in
  .env|.env.*)
    [ "$BASE" = ".env.example" ] && exit 0
    echo "Blocked: $FILE is a secrets file. Edit .env.example instead, or ask the user to change it." >&2
    exit 2 ;;
  package-lock.json|yarn.lock|pnpm-lock.yaml|Cargo.lock|go.sum|uv.lock|poetry.lock)
    echo "Blocked: $FILE is a lockfile. Change the manifest and run the package manager to regenerate it." >&2
    exit 2 ;;
esac

case "$FILE" in
  */.git/*)
    echo "Blocked: $FILE is inside .git/. Use git commands instead." >&2
    exit 2 ;;
esac

exit 0

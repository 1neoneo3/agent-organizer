#!/usr/bin/env bash
set -euo pipefail

# PostToolUse hook: sync docs/plans/*.md writes in AO worktrees to DB.
# Stdin receives JSON with tool_input.file_path and session context.
# Exits 0 always (never blocks the agent).

INPUT=$(cat)

FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only trigger for docs/plans/*.md files
case "$FILE_PATH" in
  */docs/plans/*.md) ;;
  *) exit 0 ;;
esac

# Extract task_id from .ao-worktrees/<uuid>/ in the file path
TASK_ID=$(printf '%s' "$FILE_PATH" | grep -oP '\.ao-worktrees/\K[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || echo "")

if [ -z "$TASK_ID" ]; then
  exit 0
fi

# Resolve AO_TOKEN
if [ -z "${AO_TOKEN:-}" ]; then
  for TOKEN_FILE in \
    "$HOME/agent-organizer/data/.session-token" \
    "$HOME/workspace/agent-organizer/data/.session-token"; do
    if [ -f "$TOKEN_FILE" ]; then
      AO_TOKEN=$(cat "$TOKEN_FILE")
      break
    fi
  done
fi

if [ -z "${AO_TOKEN:-}" ]; then
  echo "[sync-refinement-plan] WARNING: No AO_TOKEN found, skipping sync" >&2
  exit 0
fi

# Read the plan file content
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

CONTENT=$(cat "$FILE_PATH")

if [ -z "$CONTENT" ]; then
  exit 0
fi

AO_URL="${AO_URL:-http://localhost:8791}"

# PUT to AO API (--max-time 5 to avoid blocking the agent)
curl -sf --max-time 5 \
  -X PUT \
  -H "Authorization: Bearer $AO_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import json,sys; print(json.dumps({'content': sys.stdin.read(), 'source': 'file'}))" <<< "$CONTENT")" \
  "${AO_URL}/api/tasks/${TASK_ID}/refinement-plan" \
  > /dev/null 2>&1 || {
    echo "[sync-refinement-plan] WARNING: Failed to sync plan for task ${TASK_ID}" >&2
  }

exit 0

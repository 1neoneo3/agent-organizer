#!/usr/bin/env bash
set -euo pipefail

# Unit tests for sync-refinement-plan.sh logic
# Tests the taskId extraction and path matching patterns

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (expected='$expected', actual='$actual')"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Task ID extraction tests ==="

# Test: valid worktree path extracts UUID
RESULT=$(echo "/home/mk/workspace/datapipeline/.ao-worktrees/d27db675-cf9f-471a-a3ff-a166eaf5b45b/docs/plans/test.md" | grep -oP '\.ao-worktrees/\K[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || echo "")
assert_eq "valid worktree UUID" "d27db675-cf9f-471a-a3ff-a166eaf5b45b" "$RESULT"

# Test: another valid UUID
RESULT=$(echo "/home/mk/workspace/agent-organizer/.ao-worktrees/e02c6e3f-fb7a-4465-a251-92df37753618/docs/plans/refine.md" | grep -oP '\.ao-worktrees/\K[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || echo "")
assert_eq "another valid UUID" "e02c6e3f-fb7a-4465-a251-92df37753618" "$RESULT"

# Test: non-worktree path returns empty
RESULT=$(echo "/home/mk/workspace/datapipeline/docs/plans/test.md" | grep -oP '\.ao-worktrees/\K[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || echo "")
assert_eq "non-worktree path" "" "$RESULT"

# Test: regular project path returns empty
RESULT=$(echo "/home/mk/workspace/myproject/src/plans/test.md" | grep -oP '\.ao-worktrees/\K[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || echo "")
assert_eq "regular project path" "" "$RESULT"

echo ""
echo "=== Path matching tests ==="

# Test: docs/plans/*.md matches
match_plan_path() {
  case "$1" in
    */docs/plans/*.md) echo "match" ;;
    *) echo "no_match" ;;
  esac
}

assert_eq "docs/plans/test.md matches" "match" "$(match_plan_path "/worktree/docs/plans/test.md")"
assert_eq "docs/plans/v2-plan.md matches" "match" "$(match_plan_path "/worktree/docs/plans/v2-plan.md")"
assert_eq "src/plans/test.md no match" "no_match" "$(match_plan_path "/worktree/src/plans/test.md")"
assert_eq "docs/plans/test.txt no match" "no_match" "$(match_plan_path "/worktree/docs/plans/test.txt")"
assert_eq "docs/test.md no match" "no_match" "$(match_plan_path "/worktree/docs/test.md")"
assert_eq "src/docs/plans/test.md matches" "match" "$(match_plan_path "/worktree/src/docs/plans/test.md")"

echo ""
echo "=== Results ==="
echo "Passed: $PASS, Failed: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

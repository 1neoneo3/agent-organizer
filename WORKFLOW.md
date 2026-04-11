---
git_workflow: default
workspace_mode: git-worktree
branch_prefix: issue
codex_sandbox_mode: danger-full-access
codex_approval_policy: never
before_run: ["pnpm install"]
after_run: ["git status --short"]
include_task: true
include_review: true
include_decompose: true
enable_test_generation: true
enable_human_review: true
enable_pre_deploy: false
project_type: typescript
# Auto-checks (Phase 1): run these in parallel with the LLM reviewer
# at pr_review entry. A single failure forces rework regardless of the
# reviewer's verdict. Leave a field blank to skip that check.
check_types_cmd: pnpm exec tsc --noEmit
check_lint_cmd:
check_tests_cmd: node --import tsx --test server/workflow/stage-pipeline.test.ts server/spawner/auto-checks.test.ts server/spawner/auto-reviewer.test.ts server/spawner/prompt-builder.test.ts server/workflow/loader.test.ts
check_e2e_cmd:
---

# Agent Organizer Workflow

## Repository

- Git remote (`origin`): `https://github.com/1neoneo3/agent-organizer.git`
- Default branch: `main`

## Execution Rules

- Use a task-specific git worktree under `.ao-worktrees/<task-id>` for task execution.
- Make all code changes inside the assigned worktree, not in the shared repository root.
- Before starting implementation, inspect the relevant server and client code paths and follow the existing project structure.
- Prefer minimal, targeted changes that preserve existing behavior outside the requested scope.
- Run repository commands from the task worktree.

## Validation Rules

- Confirm the affected behavior with the smallest relevant test or verification step available.
- If tests are not run, document that explicitly in the task result.
- Review diffs for unintended changes before finishing.

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

## Important: Forbidden Commands

- **Do NOT use `rtk` command.** It does not exist in this environment. There is no `RTK.md` file. Use standard shell commands (`cat`, `sed`, `rg`, `grep`, `find`) directly.

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

## Description vs Implementation Plan

A task has two distinct text fields with separate responsibilities. Keep them
disjoint to avoid duplication and to make each surface useful on its own.

| Field | Purpose | Audience | Expected length |
|-------|---------|----------|-----------------|
| **Description** | High-level summary: what the task is and why it matters | Anyone scanning the task list / kanban card | 2–3 sentences (1 short paragraph) |
| **Implementation Plan** | Technical specification: acceptance criteria, file lists, step-by-step approach, out-of-scope notes | The agent executing the task and reviewers | As long as needed (typically multi-section markdown) |

### Guidelines

- **Description** answers "what & why". It should never duplicate the plan's
  acceptance criteria, file paths, or implementation steps. If a reader only
  reads the Description, they should understand the goal but not necessarily
  how it will be done.
- **Implementation Plan** owns all technical detail. Acceptance criteria,
  affected files, regression risk, and step-by-step instructions live here —
  not in the Description.
- When refining a task, update the plan rather than expanding the Description.
  The decomposer pipeline produces brief Descriptions intentionally.

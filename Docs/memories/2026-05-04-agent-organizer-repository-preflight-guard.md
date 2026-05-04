---
category: "memory"
importance: "medium"
type: "error_resolution"
---

# Agent Organizer repository preflight guard

AO task worktree は `project_path` が git toplevel そのものであることと、`repository_url` が origin remote と一致することを起動前に検証する必要がある。

`git -C <path> rev-parse --show-toplevel` は親 directory の repository を拾うため、`project_path=/home/mk/workspace` のような曖昧な path は無関係な repository の `.ao-worktrees/<task-id>` を作り得る。対策として `realpath(project_path) === realpath(gitToplevel)` を必須化し、origin auto-detect 不能または remote mismatch は non-retryable `SpawnPreflightError` として `human_review` に止める。

同じ事故は auto-check fallback と PR promotion でも再発し得るため、`prepareTaskWorkspace()` 失敗時に raw `project_path` へ戻らないこと、`promoteTaskReviewArtifact()` の commit/push/PR 作成前にも repository identity を再検証することが必要。

---
category: "memory"
importance: "medium"
---

# Refinement revise UI/log ordering regression

## Context
- Repository: `agent-organizer`
- Area: task revision UI badges and Activity stage grouping

## What happened
- `groupLogsByStage` assumed the incoming `task_logs` array was already chronological.
- During `refinement -> inbox -> refinement` revise flows, mixed fetch/live updates can present reverse-chronological or partially re-ordered rows.
- When that happened, the Activity panel could render stage segments in the wrong order and make the revise round-trip look inconsistent.

## Resolution
- Normalize logs inside `groupLogsByStage` by sorting on `created_at` and then `id` before segment construction.
- Centralize task revision badge/banner derivation in a pure helper (`task-revision-ui.ts`) so revise-related card UI is tested as one unit instead of split across call sites.

## Regression coverage
- Added a log-state test that reproduces reverse-chronological refine-revise input.
- Added task revision UI tests that pin `Revising`, `Revised`, and plan banner behavior.

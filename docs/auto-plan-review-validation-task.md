# Auto Plan Review Validation Task

This validation task is scoped only to the Auto Plan Review feature added for refinement plans. Use it before merging that feature to `main`.

## Task title

Validate Auto Plan Review structural/semantic repair workflow

## Task description

Verify that the `auto_plan_review` setting can be enabled and disabled, and that refinement plans are reviewed, auto-repaired, and saved with visible review/improvement status.

## Scope

- Settings persistence for `auto_plan_review`.
- Task-level override support for `auto_plan_review`.
- Refinement-plan save behavior when Auto Plan Review is disabled.
- Refinement-plan save behavior when Auto Plan Review is enabled and the plan already passes.
- Refinement-plan save behavior when Auto Plan Review is enabled and the plan needs structural or semantic repair.
- Review block visibility, including initial status, replan status, final status, review comments, and improvement status.

## Out of scope

- Unrelated workflow-stage behavior.
- General QA-agent behavior.
- GitHub branch protection configuration.
- Broad E2E coverage for task CRUD features that do not touch Auto Plan Review.

## Suggested checks

1. Run the focused process-manager tests that exercise the refinement-plan persistence path.
2. Run the settings route tests to confirm the new setting round-trips through the settings API.
3. Run TypeScript type checking for the touched server and UI code.
4. Manually create or simulate a refinement plan with missing sections and confirm `## Auto Plan Improvements` and `## Auto Plan Review` are saved once, without duplicate generated blocks.
5. Confirm initially passing checks remain marked `Done`, while checks repaired by the auto-replan are marked `Auto-fixed`.

## Acceptance criteria

- [ ] Disabled Auto Plan Review leaves saved plans unchanged.
- [ ] Enabled Auto Plan Review appends a single review block to passing plans.
- [ ] Enabled Auto Plan Review auto-repairs incomplete plans before saving.
- [ ] Repaired plans show `Initial Status`, `Replan Status`, and `Final Status`.
- [ ] Improvement status distinguishes `Done`, `Auto-fixed`, and `Open` accurately.
- [ ] Focused tests and typecheck pass before merge.

## Commands

```sh
pnpm exec tsx --test server/spawner/process-manager.test.ts server/routes/settings.test.ts
pnpm exec tsc --noEmit
```

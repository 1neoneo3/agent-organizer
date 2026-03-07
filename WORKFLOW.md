---
codex_sandbox_mode: workspace-write
codex_approval_policy: on-request
e2e_execution: host
e2e_command: pnpm test:e2e
---

# Agent Organizer Workflow

## Repository

- Git remote (`origin`): `https://github.com/1neoneo3/agent-organizer.git`
- Default branch: `main`

## Execution Rules

- Spawned Codex agents run with `workspace-write` by default. In this mode, localhost listen and socket creation are treated as unavailable.
- Do not run Playwright `webServer` or `pnpm test:e2e` inside a sandboxed Codex task unless you explicitly switch `codex_sandbox_mode` to `danger-full-access`.
- Default E2E route is host execution. Report `pnpm test:e2e` for a human or external runner to execute from the repository root.
- If host execution is not available, delegate E2E to CI and state that limitation clearly in the task result.
- Before starting implementation, inspect the relevant server and client code paths and follow the existing project structure.
- Prefer minimal, targeted changes that preserve existing behavior outside the requested scope.

## Validation Rules

- Confirm the affected behavior with the smallest relevant test or verification step available.
- If tests are not run, document that explicitly in the task result.
- Review diffs for unintended changes before finishing.

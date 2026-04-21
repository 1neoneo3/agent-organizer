# Agent Organizer

Multi-agent orchestration dashboard for managing AI agent (Claude / Codex / Gemini CLI) task workflows with a configurable quality pipeline.

## Quick Start

The recommended first-run path is the npm CLI:

```bash
npx agent-organizer@latest start
```

This command runs the published `agent-organizer` package, creates local
runtime state in `~/.agent-organizer`, ensures Redis is available, and starts
the production server in the foreground.

If npm returns `404 Not Found`, the package has not been published to npm from
this repository yet. See [npm Package Publishing](#npm-package-publishing).

Open the URL printed by the command, usually:

```text
http://localhost:8791
```

### Requirements

- Node.js 22 or newer
- Docker, or a Redis server already running on `127.0.0.1:6379`
- At least one supported agent CLI if you want tasks to run: `claude`, `codex`, or `gemini`

Useful follow-up commands:

```bash
npx agent-organizer@latest doctor
npx agent-organizer@latest status
npx agent-organizer@latest stop
```

For reproducible installs, pin a version instead of `latest`:

```bash
npx agent-organizer@0.1.0 start
```

What `start` does:

- Requires Node.js 22 or newer
- Creates `~/.agent-organizer/.env` and `~/.agent-organizer/data`
- Generates a persistent `SESSION_AUTH_TOKEN`
- Uses Redis on `127.0.0.1:6379` when available
- Starts a Docker Redis container named `agent-organizer-redis` when Redis is not already running
  and binds it to `127.0.0.1` only
- Runs Agent Organizer from the npm package with SQLite data stored outside the package cache
- Serves the built UI and API from the same server on `PORT` (default `8791`)

If Docker is not installed and Redis is not already running, install Docker or
start Redis locally before running `start`.

> Security note: `npx` executes code from the npm package you request. For
> production or shared machines, prefer pinning a reviewed version such as
> `agent-organizer@0.1.0`.

## Current Distribution

- npm package name: `agent-organizer`
- CLI binary: `agent-organizer`
- Primary command: `npx agent-organizer@latest start`
- Publish status: configured in this repository; requires `npm publish` from an authenticated npm account
- Runtime home: `~/.agent-organizer`
- Runtime data: `~/.agent-organizer/data`
- Default URL: `http://localhost:8791`
- Default Redis: `redis://127.0.0.1:6379`
- License: MIT

## Features

- Kanban task board with drag-and-drop
- Multi-agent spawning and lifecycle management (Claude, Codex, Gemini)
- Configurable quality pipeline with optional stages
- Per-task workspace isolation via `git worktree` (`.ao-worktrees/<taskId>`)
- Real-time WebSocket updates and terminal output streaming
- Interactive prompt handling (plan approval, agent questions)
- Directive → task decomposition and refinement-plan splitting
- Orphan recovery with auto-respawn (crash-resilient `in_progress` tasks)
- Parallel auto-checks (tsc / lint / test / e2e) and multi-role PR review
- Output language switch for agent-generated text (ja / en)
- GitHub issue sync, Kanban sync, and auto-dispatch
- Telegram notifications and approval commands
- Token-based session authentication
- Optional Redis cache layer (ioredis)

## Task Pipeline

Tasks flow through a configurable series of stages. Each optional stage can be toggled on/off via Settings or per-project `WORKFLOW.md`.

```
inbox → [refinement] → in_progress → [test_generation] → [ci_check] → [qa_testing] → [pr_review] → [human_review] → done
                                                                                                                 ↘ cancelled
```

### Stage Reference

| Stage | What happens | Toggle | What it enforces |
|-------|-------------|--------|-----------------|
| **inbox** | Task created, waiting for dispatch | Always on | — |
| **refinement** | Agent analyzes codebase (read-only) and produces a structured plan: business requirements, technical requirements, acceptance criteria, files to modify, implementation steps, risks | `default_enable_refinement` | Requirements definition before coding starts. Human approval gate optional (`refinement_auto_approve`) |
| **in_progress** | Agent implements the task. Optional explore phase runs first (read-only investigation) | Always on | — |
| **test_generation** | Dedicated tester agent writes unit/integration tests for the implementation. Skipped for small tasks | `default_enable_test_generation` | Test coverage — a separate agent writes tests, not the implementer |
| **ci_check** | Agent verifies CI/CD infrastructure: workflows exist, type check passes, linter passes, tests pass | `default_enable_ci_check` | Build correctness — `[CI_CHECK:PASS]` marker required to advance |
| **qa_testing** | QA agent runs the application, tests user flows, and verifies acceptance criteria | `qa_mode` | Functional testing — `[QA:FAIL]` sends task back to implementation |
| **pr_review** | Code review agent(s) check quality, security, correctness. Auto-checks (tsc/lint/test/e2e) run in parallel | `review_mode` | Code quality — multi-role review panel (code + security). Auto-checks gate: any failing check blocks advancement regardless of reviewer verdict |
| **human_review** | Human approves or rejects via UI before task completes | `default_enable_human_review` | Human approval gate — Approve/Reject with feedback |
| **done** | Terminal state. `completed_at` stamped, agent released | Always on | — |
| **cancelled** | Terminal state. Can be resumed to `in_progress` or reopened to inbox | Always on | — |

### Transient Markers (not pipeline stages)

| Marker | What happens |
|--------|-------------|
| **self_review** | Agent self-reviews its own work before returning to pipeline. Controlled by `self_review_threshold` setting (none/small/medium/all) |

### What Each Stage Enforces

**Requirements & Planning**
- Refinement stage forces structured requirements definition (business reqs, technical reqs, acceptance criteria) before any code is written
- Human can approve, reject, or request plan revisions via feedback

**Testing**
- Test generation stage ensures a separate agent writes tests (not the implementer who knows the shortcuts)
- CI check stage verifies type checking (`tsc`), linting, unit tests, and E2E all pass
- QA testing stage runs functional acceptance testing against the running application
- Auto-checks at PR review run `tsc`, lint, test, and e2e commands in parallel — a single failure blocks the task

**Code Quality**
- PR review supports multi-role panels (code reviewer + security reviewer running in parallel)
- Review verdicts are role-tagged: `[REVIEW:code:PASS]`, `[REVIEW:security:NEEDS_CHANGES]`
- Failed reviews send the task back to `in_progress` for rework, then resume from the failed stage

**Human Oversight**
- Refinement approval gate (optional): human reviews plan before implementation starts
- Human review gate (optional): human approves final result before task completes
- Interactive prompts: agent can ask questions mid-task, human responds via UI

## Settings

All pipeline behavior is controlled through the Settings UI (`/settings`).

| Setting | Values | Effect |
|---------|--------|--------|
| `default_enable_refinement` | true/false | Enable refinement (planning) stage before implementation |
| `refinement_auto_approve` | true/false | Skip human approval of refinement plan |
| `default_enable_test_generation` | true/false | Enable dedicated test generation stage (skipped for small tasks) |
| `default_enable_ci_check` | true/false | Enable CI/CD verification stage |
| `qa_mode` | enabled/disabled | Enable QA testing stage |
| `review_mode` | none/pr_only/meeting | PR review stage control |
| `default_enable_human_review` | true/false | Enable human approval gate |
| `self_review_threshold` | none/small/medium/all | Agent self-review by task size |
| `auto_review` | true/false | Auto-trigger review agent on PR review entry |
| `auto_qa` | true/false | Auto-trigger QA agent on QA testing entry |
| `auto_checks_enabled` | true/false | Run tsc/lint/test/e2e in parallel at PR review |
| `auto_dispatch_mode` | disabled/github_only/all_inbox | Auto-assign idle agents to inbox tasks |
| `review_count` | number | Max review iterations before escalation |
| `qa_count` | number | Max QA iterations before escalation |
| `output_language` | ja/en | Natural-language output of agent-generated titles, descriptions, refinement plans, review/QA text, and PR bodies. Control tokens (`[REVIEW:...]`, `---REFINEMENT PLAN---` etc.) remain stable across languages |
| `default_workspace_mode` | shared/git-worktree | Default workspace isolation strategy. `git-worktree` spins up `.ao-worktrees/<taskId>` on its own branch per `in_progress` task; `shared` uses the main checkout |
| `refinement_agent_id` | agent id / empty | Preferred agent for the refinement (planning) stage. Empty = role-based resolver |
| `review_agent_id` | agent id / empty | Preferred agent for PR review |
| `qa_agent_id` | agent id / empty | Preferred agent for QA testing |
| `test_generation_agent_id` | agent id / empty | Preferred agent for test generation |
| `ci_check_agent_id` | agent id / empty | Preferred agent for CI check |

Settings are the single source of truth (SSOT). Per-project `WORKFLOW.md` frontmatter serves as a fallback only when the setting is absent.

### Orphan Recovery

A background job (`server/lifecycle/jobs.ts`) detects tasks marked `in_progress` / `refinement` whose agent process has died. Each orphan is auto-respawned up to `ORPHAN_AUTO_RESPAWN_MAX` times (default **3**, env-overridable). After the budget is exhausted the task is parked with an explanatory log entry — press Run, send feedback, or use the Resume button to continue. The counter resets on any forward stage transition, manual Run, or feedback-rework.

Stuck auto-stage tasks (`pr_review`, `qa_testing`, `test_generation`, `ci_check`) with a stale `last_heartbeat_at` (> 10 min) are promoted to `human_review` instead of being silently retried.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4 + React Router 7
- **Backend**: Express 5 + WebSocket (ws) + Node.js 22
- **Database**: SQLite (`node:sqlite`)
- **Cache (optional)**: Redis via ioredis (disable with `REDIS_ENABLED=false`)
- **CLI Agents**: Claude Code, Codex, Gemini CLI
- **E2E Testing**: Playwright

## Setup

```bash
# Requirements: Node.js >= 22, pnpm
pnpm install
cp .env.example .env  # Edit SESSION_AUTH_TOKEN (a random token is auto-generated on first run if left as the placeholder)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8791` | Server port |
| `NODE_ENV` | `development` | `development` / `production` |
| `SESSION_AUTH_TOKEN` | auto-generated | Session token. Placeholder value triggers auto-generation into `data/.session-token` |
| `DB_PATH` | `data/agent-organizer.db` | SQLite database path |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis endpoint for cache |
| `REDIS_ENABLED` | `true` | Set `false` to run without Redis |
| `AUTO_ASSIGN_TASK_ON_CREATE` | `true` | Auto-assign an agent when a task is created |
| `AUTO_RUN_TASK_ON_CREATE` | `true` | Auto-spawn the agent immediately after creation |
| `AUTO_DISPATCH_INTERVAL_MS` | `60000` | Auto-dispatcher tick interval |
| `ORPHAN_AUTO_RESPAWN_MAX` | `3` | Max auto-respawns per orphaned task |
| `GITHUB_SYNC_ENABLED` | `false` | Enable GitHub Issue → task sync |
| `GITHUB_SYNC_REPO` | derived from git remote | `owner/name` |
| `GITHUB_SYNC_TOKEN` | from `gh auth token` | PAT for sync |
| `GITHUB_SYNC_PROJECT_PATH` | project root | Working directory for synced tasks |
| `GITHUB_SYNC_INTERVAL_MS` | `300000` | Sync poll interval |
| `TELEGRAM_CONTROL_ENABLED` | `true` | Enable Telegram control bot |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for notifications / approvals |

## Development

```bash
pnpm dev            # Start both server (8791) and client (Vite)
pnpm dev:server     # Server only
pnpm dev:client     # Vite dev server only
pnpm lint           # TypeScript static checks (tsc --noEmit)
pnpm check          # Same as lint
```

## Production

```bash
pnpm build
pnpm start
```

## npm Package Publishing

The package is configured for npm distribution under the `agent-organizer`
package name. Publishing requires npm authentication:

```bash
npm login
npm publish --access public
```

`prepack` runs `pnpm build` before packaging so `dist/` is included in the
published package. `npm pack --dry-run` can be used to inspect the package
contents before publishing.

## Testing

```bash
pnpm test           # Run unit/integration tests via tsx + node:test
pnpm test:e2e       # Run Playwright E2E tests
pnpm test:e2e:ui    # Run with Playwright UI
```

E2E tests in `e2e/` cover agent CRUD, task CRUD, task flow, and settings scenarios. Playwright auto-starts the server via config.

## Project Structure

```
server/
  cache/             # Redis cache service (noop when REDIS_ENABLED=false)
  config/            # Runtime configuration, defaults, settings resolver
  db/                # SQLite schema, migrations
  dispatch/          # Auto-dispatch scheduler
  domain/            # Task status constants, stage rules
  lifecycle/         # Background jobs (orphan recovery, auto-respawn)
  notify/            # Telegram notifications + control bot
  perf/              # Performance metrics
  routes/            # REST API endpoints
    integrations/    #   Kanban sync endpoint
  security/          # Authentication middleware
  spawner/           # Agent process management, prompt builders
  static-handlers.ts # Production static serving for dist/
  tasks/             # Task dispatch / creation logic
  types/             # TypeScript interfaces
  utils/             # Shared helpers
  workflow/          # Stage pipeline, WORKFLOW.md loader, worktree management
  ws/                # WebSocket hub (event batching)
src/
  api/               # API client
  components/
    agents/          # Agent list and forms
    directives/      # Directive management + decomposition
    layout/          # App shell, sidebar
    settings/        # Settings panel
    tasks/           # Task board, cards, detail modal, terminal viewer
    terminal/        # Terminal output viewer
  hooks/             # Custom React hooks
  types/             # Frontend TypeScript types
e2e/                 # Playwright E2E tests
data/
  agent-organizer.db # SQLite database
.ao-worktrees/       # Per-task git worktrees at repo root (when workspace_mode = git-worktree)
```

## API Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/tasks | List tasks (optional `?status=` filter) |
| GET | /api/tasks/interactive-prompts | List all pending interactive prompts |
| GET | /api/tasks/:id | Get task detail |
| POST | /api/tasks | Create task |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| GET | /api/tasks/:id/settings | Get per-task setting overrides |
| PUT | /api/tasks/:id/settings | Merge per-task setting overrides |
| DELETE | /api/tasks/:id/settings | Clear per-task setting overrides |
| POST | /api/tasks/:id/run | Start task (assign agent and spawn) |
| POST | /api/tasks/:id/stop | Stop running task |
| POST | /api/tasks/:id/resume | Resume a cancelled task (restores `in_progress`) |
| POST | /api/tasks/:id/approve | Approve task (refinement or human_review) |
| POST | /api/tasks/:id/reject | Reject task (refinement or human_review) |
| POST | /api/tasks/:id/split | Split a refinement plan into individual child tasks |
| POST | /api/tasks/:id/feedback | Send feedback to running/completed task |
| GET | /api/tasks/:id/logs | Get task logs (paginated) |
| GET | /api/tasks/:id/terminal | Pretty-printed terminal view |
| POST | /api/tasks/:id/interactive-response | Respond to agent prompt |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agents | List agents (with workload) |
| GET | /api/agents/:id | Get agent detail |
| POST | /api/agents | Create agent |
| PUT | /api/agents/:id | Update agent |
| DELETE | /api/agents/:id | Delete agent |

### Directives

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/directives | List directives |
| GET | /api/directives/:id | Get directive detail |
| POST | /api/directives | Create directive |
| PUT | /api/directives/:id | Update directive |
| DELETE | /api/directives/:id | Delete directive |
| POST | /api/directives/:id/decompose | Run LLM decomposition into child tasks |
| GET | /api/directives/:id/decompose-logs | Decomposition log stream |
| GET | /api/directives/:id/tasks | List child tasks |
| GET | /api/directives/:id/plan | Decomposition plan |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/messages | List messages |
| POST | /api/messages | Post a message |

### Integrations

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/integrations/kanban/sync | Sync tasks with an external Kanban source |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/auth/session | Current session info (returns unauthenticated if no token) |
| GET | /api/settings | Get all settings |
| PUT | /api/settings | Update settings (bulk) |
| GET | /api/health | Health check |
| GET | /api/cli-status | Available CLI tools |
| WS | /ws | Real-time WebSocket updates |

## License

Agent Organizer is released under the MIT License. See [LICENSE](LICENSE).

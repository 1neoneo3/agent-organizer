# Agent Organizer

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-E2E-2EAD33?logo=playwright&logoColor=white)

Multi-agent orchestration dashboard for managing AI agent (Claude / Codex / Gemini CLI) task workflows with a configurable quality pipeline.

## Features

- Kanban task board with drag-and-drop
- Multi-agent spawning and lifecycle management (Claude, Codex, Gemini)
- Configurable quality pipeline with optional stages
- Real-time WebSocket updates and terminal output streaming
- Interactive prompt handling (plan approval, agent questions)
- GitHub issue sync and auto-dispatch
- Telegram notifications
- Token-based session authentication

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
| **cancelled** | Terminal state. Can be reopened to inbox | Always on | — |

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

Settings are the single source of truth (SSOT). Per-project `WORKFLOW.md` frontmatter serves as a fallback only when the setting is absent.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Express + WebSocket (ws) + Node.js 22
- **Database**: SQLite (node:sqlite)
- **CLI Agents**: Claude Code, Codex, Gemini CLI
- **E2E Testing**: Playwright

## Setup

```bash
# Requirements: Node.js >= 22, pnpm
pnpm install
cp .env.example .env  # Edit SESSION_AUTH_TOKEN
```

## Development

```bash
pnpm dev            # Start both server and client
pnpm dev:server     # Server only (port 8791)
pnpm dev:client     # Vite dev server only
pnpm check          # TypeScript type check
```

## Production

```bash
pnpm build
pnpm start
```

## Testing

```bash
pnpm test:e2e       # Run Playwright E2E tests
pnpm test:e2e:ui    # Run with Playwright UI
```

E2E tests in `e2e/` cover agent CRUD, task CRUD, task flow, and settings scenarios. Playwright auto-starts the server via config.

## Project Structure

```
server/
  config/         # Runtime configuration, defaults
  db/             # SQLite schema, migrations
  dispatch/       # Auto-dispatch scheduler
  domain/         # Task status constants, rules
  lifecycle/      # Background jobs (orphan recovery)
  notify/         # Telegram notifications
  perf/           # Performance metrics
  routes/         # REST API endpoints
  security/       # Authentication middleware
  spawner/        # Agent process management, prompt builders
  tasks/          # Task dispatch logic
  types/          # TypeScript interfaces
  workflow/       # Stage pipeline, WORKFLOW.md loader, workspace management
  ws/             # WebSocket hub
src/
  api/            # API client
  components/
    agents/       # Agent list and forms
    directives/   # Directive management
    layout/       # App shell, sidebar
    settings/     # Settings panel
    tasks/        # Task board, cards, detail modal
    terminal/     # Terminal output viewer
  hooks/          # Custom React hooks
  types/          # Frontend TypeScript types
e2e/              # Playwright E2E tests
```

## API Endpoints

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/tasks | List tasks (optional `?status=` filter) |
| GET | /api/tasks/:id | Get task detail |
| POST | /api/tasks | Create task |
| PUT | /api/tasks/:id | Update task |
| DELETE | /api/tasks/:id | Delete task |
| POST | /api/tasks/:id/run | Start task (assign agent and spawn) |
| POST | /api/tasks/:id/stop | Stop running task |
| POST | /api/tasks/:id/approve | Approve task (refinement or human_review) |
| POST | /api/tasks/:id/reject | Reject task (refinement or human_review) |
| POST | /api/tasks/:id/feedback | Send feedback to running/completed task |
| GET | /api/tasks/:id/logs | Get task logs (paginated) |
| GET | /api/tasks/:id/terminal | Pretty-printed terminal view |
| POST | /api/tasks/:id/interactive-response | Respond to agent prompt |
| GET | /api/tasks/interactive-prompts | List all pending prompts |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agents | List agents |
| GET | /api/agents/:id | Get agent detail |
| POST | /api/agents | Create agent |
| PUT | /api/agents/:id | Update agent |
| DELETE | /api/agents/:id | Delete agent |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/settings | Get all settings |
| PUT | /api/settings | Update settings (bulk) |
| GET | /api/health | Health check |
| GET | /api/cli-status | Available CLI tools |
| WS | /ws | Real-time WebSocket updates |

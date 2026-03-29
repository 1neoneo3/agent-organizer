# Agent Organizer

Multi-agent orchestration dashboard for managing AI agent workflows.

## Features

- Agent spawning and lifecycle management
- Task board with drag-and-drop Kanban
- Real-time WebSocket updates
- Terminal output streaming
- Token-based session authentication

## Tech Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Vite
- **Backend**: Express 5 + WebSocket (ws)
- **Database**: SQLite (via better-sqlite3)

## Setup

```bash
# Requirements: Node.js >= 22, pnpm
pnpm install
cp .env.example .env  # Edit SESSION_AUTH_TOKEN
```

## Development

```bash
pnpm dev          # Start both server and client
pnpm dev:server   # Server only (port 8791)
pnpm dev:client   # Vite dev server only
```

## Production

```bash
pnpm build
pnpm start
```

## Testing

```bash
pnpm exec tsx --test src/examples/typescript-basics.test.ts  # Run the TypeScript sample test
pnpm test:e2e       # Run Playwright E2E tests
pnpm test:e2e:ui    # Run with Playwright UI
```

E2E tests are located in `e2e/` and cover agent CRUD, task CRUD, and task flow scenarios.

Requires the server to be running (Playwright auto-starts it via config).

## TypeScript Sample

`src/examples/typescript-basics.ts` contains a small TypeScript example with:

- typed interfaces
- union types
- readonly array handling
- small pure functions for testable behavior

## Project Structure

```
server/
  config/       # Runtime configuration
  db/           # SQLite schema and initialization
  lifecycle/    # Background jobs (orphan recovery)
  routes/       # REST API endpoints
  security/     # Authentication middleware
  spawner/      # Agent process management
  ws/           # WebSocket hub
src/
  components/   # React components
    agents/     # Agent list and forms
    layout/     # App shell and sidebar
    settings/   # Settings panel
    tasks/      # Task board, cards, modals
    terminal/   # Terminal output viewer
  hooks/        # Custom React hooks
  api/          # API client
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Session authentication |
| GET | /api/agents | List agents |
| POST | /api/agents/spawn | Spawn a new agent |
| GET | /api/tasks | List tasks |
| POST | /api/tasks | Create task |
| PATCH | /api/tasks/:id | Update task |
| GET | /api/messages | List messages |
| WS | /ws | Real-time updates |

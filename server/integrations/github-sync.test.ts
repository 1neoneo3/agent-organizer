import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it, mock } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  fetchGitHubIssues,
  resolveGitHubSyncToken,
  startGithubIssueSync,
  syncGithubIssues,
  type GitHubIssue,
} from "./github-sync.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function createWs() {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sent,
    broadcast(type: string, payload: unknown) {
      sent.push({ type, payload });
    },
  };
}

function insertAgent(db: DatabaseSync) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agents (
      id, name, cli_provider, cli_model, cli_reasoning_level, avatar_emoji, role, personality,
      status, current_task_id, stats_tasks_done, created_at, updated_at
    ) VALUES (?, ?, 'codex', NULL, NULL, ':robot:', NULL, NULL, 'idle', NULL, 0, ?, ?)`
  ).run("agent-1", "Worker", now, now);
}

function insertTask(
  db: DatabaseSync,
  overrides: {
    id: string;
    title: string;
    status: string;
    projectPath: string;
    taskNumber: string;
    plannedFiles?: string[] | null;
  },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (
      id, title, status, task_size, task_number, project_path, planned_files, created_at, updated_at
    ) VALUES (?, ?, ?, 'medium', ?, ?, ?, ?, ?)`
  ).run(
    overrides.id,
    overrides.title,
    overrides.status,
    overrides.taskNumber,
    overrides.projectPath,
    overrides.plannedFiles ? JSON.stringify(overrides.plannedFiles) : null,
    now,
    now,
  );
}

function issue(number: number, title = "Issue title"): GitHubIssue {
  return {
    id: number,
    number,
    title,
    body: "Issue body",
    html_url: `https://github.com/example/repo/issues/${number}`,
    state: "open",
    labels: [],
  };
}

describe("syncGithubIssues", () => {
  it("creates inbox tasks for new GitHub issues", () => {
    const db = createDb();
    const ws = createWs();

    const result = syncGithubIssues(db, ws as never, [issue(12)], { projectPath: "/tmp/project" });
    const row = db.prepare("SELECT * FROM tasks WHERE external_source = 'github' AND external_id = '12'").get() as {
      title: string;
      status: string;
      project_path: string;
    };

    assert.equal(result.created, 1);
    assert.equal(row.title, "[GH #12] Issue title");
    assert.equal(row.status, "inbox");
    assert.equal(row.project_path, "/tmp/project");
  });

  it("updates existing mirrored tasks", () => {
    const db = createDb();
    const ws = createWs();
    syncGithubIssues(db, ws as never, [issue(12)], { projectPath: "/tmp/project" });

    const result = syncGithubIssues(db, ws as never, [issue(12, "Renamed issue")], { projectPath: "/tmp/project" });
    const row = db.prepare("SELECT title FROM tasks WHERE external_source = 'github' AND external_id = '12'").get() as {
      title: string;
    };

    assert.equal(result.updated, 1);
    assert.equal(row.title, "[GH #12] Renamed issue");
  });

  it("cancels stale inbox tasks when the issue disappears from the open set", () => {
    const db = createDb();
    const ws = createWs();
    syncGithubIssues(db, ws as never, [issue(12)], { projectPath: "/tmp/project" });

    const result = syncGithubIssues(db, ws as never, [], { projectPath: "/tmp/project" });
    const row = db.prepare("SELECT status FROM tasks WHERE external_source = 'github' AND external_id = '12'").get() as {
      status: string;
    };

    assert.equal(result.cancelled, 1);
    assert.equal(row.status, "cancelled");
  });

  it("assigns correct task_number when hex fragments exist in DB (regression: UUID poisoning)", () => {
    const db = createDb();
    const ws = createWs();
    const now = Date.now();

    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("pre-valid", "Previous task", "#5", now - 2000, now);
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("pre-hex", "Hex poison", "#40b0c5", now - 1000, now);
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("pre-hex2", "Leading zero poison", "#082098", now - 500, now);

    syncGithubIssues(db, ws as never, [issue(99)], { projectPath: "/tmp/project" });

    const row = db.prepare(
      "SELECT task_number FROM tasks WHERE external_source = 'github' AND external_id = '99'",
    ).get() as { task_number: string };

    assert.equal(row.task_number, "#6", "task_number must follow from #5, ignoring hex fragments #40b0c5 and #082098");
  });

  it("auto-dispatches newly mirrored tasks when enabled", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    const started: Array<{ agentId: string; taskId: string }> = [];

    const result = syncGithubIssues(db, ws as never, [issue(12)], {
      projectPath: "/tmp/project",
      autoAssign: true,
      autoRun: true,
      spawnAgent: (_db, _ws, agent, task) => {
        started.push({ agentId: agent.id, taskId: task.id });
        return Promise.resolve({ pid: 123 });
      },
    });
    const row = db.prepare(
      "SELECT id, assigned_agent_id FROM tasks WHERE external_source = 'github' AND external_id = '12'"
    ).get() as { id: string; assigned_agent_id: string | null };

    assert.equal(result.created, 1);
    assert.equal(row.assigned_agent_id, "agent-1");
    assert.deepEqual(started, [{ agentId: "agent-1", taskId: row.id }]);
  });

  it("assigns an idle agent to mirrored inbox tasks even when auto-run is disabled", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    let spawnCalls = 0;

    const result = syncGithubIssues(db, ws as never, [issue(12)], {
      projectPath: "/tmp/project",
      autoAssign: true,
      autoRun: false,
      spawnAgent: () => {
        spawnCalls += 1;
        return Promise.resolve({ pid: 123 });
      },
    });
    const row = db.prepare(
      "SELECT id, status, assigned_agent_id FROM tasks WHERE external_source = 'github' AND external_id = '12'"
    ).get() as { id: string; status: string; assigned_agent_id: string | null };

    assert.equal(result.created, 1);
    assert.equal(row.status, "inbox");
    assert.equal(row.assigned_agent_id, "agent-1");
    assert.equal(spawnCalls, 0);
    assert.ok(
      ws.sent.some((event) => event.type === "task_update" && (event.payload as { assigned_agent_id?: string | null }).assigned_agent_id === "agent-1"),
      "task_update websocket payload should include the assigned agent",
    );
  });

  it("keeps mirrored GitHub tasks in inbox when they conflict with an active task", () => {
    const db = createDb();
    const ws = createWs();
    insertAgent(db);
    const started: Array<{ agentId: string; taskId: string }> = [];
    insertTask(db, {
      id: "active-1",
      title: "Implement auth redirect",
      status: "in_progress",
      projectPath: "/tmp/project",
      taskNumber: "#1",
      plannedFiles: ["src/auth.ts"],
    });

    const result = syncGithubIssues(db, ws as never, [
      {
        ...issue(12, "Fix auth redirect"),
        body: "Adjust the redirect flow.\n- `src/auth.ts`",
      },
    ], {
      projectPath: "/tmp/project",
        autoAssign: true,
        autoRun: true,
        spawnAgent: (_db, _ws, agent, task) => {
          started.push({ agentId: agent.id, taskId: task.id });
          return Promise.resolve({ pid: 123 });
        },
      });

    const row = db.prepare(
      "SELECT status, assigned_agent_id FROM tasks WHERE external_source = 'github' AND external_id = '12'"
    ).get() as { status: string; assigned_agent_id: string | null };
    const logs = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = (SELECT id FROM tasks WHERE external_source = 'github' AND external_id = '12') ORDER BY id ASC"
    ).all() as Array<{ message: string }>;

    assert.equal(result.created, 1);
    assert.equal(row.status, "inbox");
    assert.equal(row.assigned_agent_id, "agent-1");
    assert.deepEqual(started, []);
    assert.match(logs.map((entry) => entry.message).join("\n"), /github sync conflicts/i);
    assert.match(logs.map((entry) => entry.message).join("\n"), /src\/auth\.ts/i);
  });
});

describe("fetchGitHubIssues", () => {
  it("omits Authorization when token is blank", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (
      _input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1],
    ) => {
      const headers = new Headers((init as RequestInit | undefined)?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.get("accept"), "application/vnd.github+json");
      assert.equal(headers.get("user-agent"), "agent-organizer-github-sync");

      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const issues = await fetchGitHubIssues("example/repo", "");
      assert.deepEqual(issues, []);
    } finally {
      fetchMock.mock.restore();
    }
  });
});

describe("resolveGitHubSyncToken", () => {
  it("prefers the configured env token", () => {
    let readCalls = 0;

    const token = resolveGitHubSyncToken("env-token", () => {
      readCalls += 1;
      return "gh-token";
    });

    assert.equal(token, "env-token");
    assert.equal(readCalls, 0);
  });

  it("falls back to gh auth token when env token is empty", () => {
    const token = resolveGitHubSyncToken("", () => "gh-token\n");

    assert.equal(token, "gh-token");
  });
});

describe("startGithubIssueSync", () => {
  it("starts polling even when the initial token is blank", async () => {
    const db = createDb();
    const ws = createWs();
    const scheduled: Array<() => void> = [];

    startGithubIssueSync(
      db,
      ws as never,
      async (repo, token) => {
        assert.equal(repo, "example/repo");
        assert.equal(token, "");
        return [issue(42, "Public issue")];
      },
      {
        resolveRepo: () => "example/repo",
        resolveToken: () => "",
        schedule: ((handler: Parameters<typeof setInterval>[0]) => {
          scheduled.push(() => {
            if (typeof handler === "function") {
              handler();
            }
          });
          return 1 as never;
        }) as unknown as typeof setInterval,
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(scheduled.length, 1);
    const row = db.prepare(
      "SELECT title FROM tasks WHERE external_source = 'github' AND external_id = '42'",
    ).get() as { title: string } | undefined;

    assert.equal(row?.title, "[GH #42] Public issue");
  });
});

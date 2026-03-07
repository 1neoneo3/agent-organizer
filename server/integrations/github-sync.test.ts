import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import { syncGithubIssues, type GitHubIssue } from "./github-sync.js";

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
});

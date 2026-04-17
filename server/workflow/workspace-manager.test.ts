import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { prepareTaskWorkspace, resolveWorkspaceMode } from "./workspace-manager.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-worktree-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "ao@example.com");
  git(dir, "config", "user.name", "Agent Organizer");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "init");
  return dir;
}

describe("prepareTaskWorkspace", () => {
  it("returns the original project path for shared mode", () => {
    const repo = initRepo();
    const workspace = prepareTaskWorkspace(
      {
        id: "task-1",
        title: "Shared task",
        task_number: "#1",
        project_path: repo,
      } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "shared",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
          enableRefinement: null,
  enableTestGeneration: false,
          enableHumanReview: false,
          enableCiCheck: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
      },
    );

    assert.equal(workspace.cwd, repo);
    assert.equal(workspace.branchName, null);
  });

  it("creates a deterministic git worktree for the task", () => {
    const repo = initRepo();
    const workflow = {
      body: "",
      codexSandboxMode: "workspace-write" as const,
      codexApprovalPolicy: "on-request" as const,
      e2eExecution: "host" as const,
      e2eCommand: null,
      gitWorkflow: "default" as const,
      workspaceMode: "git-worktree" as const,
      branchPrefix: "issue",
      beforeRun: [],
      afterRun: [],
      includeTask: true,
      includeReview: true,
      includeDecompose: true,
          enableRefinement: null,
  enableTestGeneration: false,
          enableHumanReview: false,
          enableCiCheck: false,
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
    };

    const workspace = prepareTaskWorkspace(
      {
        id: "task-2",
        title: "Add workflow support",
        task_number: "#42",
        project_path: repo,
      } as never,
      workflow,
    );

    assert.equal(workspace.rootPath, repo);
    assert.match(workspace.branchName ?? "", /^issue\/t42-add-workflow-support$/);
    assert.equal(existsSync(workspace.cwd), true);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branchName);
  });
});

function makeSettingsDb(defaultWorkspaceMode?: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (defaultWorkspaceMode !== undefined) {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "default_workspace_mode",
      defaultWorkspaceMode,
    );
  }
  return db;
}

describe("resolveWorkspaceMode", () => {
  it("defaults to git-worktree when no workflow and no db setting", () => {
    assert.equal(resolveWorkspaceMode(null), "git-worktree");
  });

  it("defaults to git-worktree when the db setting is missing", () => {
    const db = makeSettingsDb();
    assert.equal(resolveWorkspaceMode(null, db), "git-worktree");
  });

  it("uses the db setting when workflow.workspaceMode is null", () => {
    const db = makeSettingsDb("shared");
    assert.equal(
      resolveWorkspaceMode(
        { workspaceMode: null, branchPrefix: "ao" } as never,
        db,
      ),
      "shared",
    );
  });

  it("explicit WORKFLOW.md value wins over db setting", () => {
    const db = makeSettingsDb("shared");
    assert.equal(
      resolveWorkspaceMode(
        { workspaceMode: "git-worktree", branchPrefix: "ao" } as never,
        db,
      ),
      "git-worktree",
    );
  });

  it("ignores unrecognized db setting values", () => {
    const db = makeSettingsDb("bogus");
    assert.equal(resolveWorkspaceMode(null, db), "git-worktree");
  });

  it("tolerates a db without a settings table", () => {
    const db = new DatabaseSync(":memory:");
    assert.equal(resolveWorkspaceMode(null, db), "git-worktree");
  });
});

describe("prepareTaskWorkspace — global default fallback", () => {
  it("creates a worktree when no workflow is provided and db default is git-worktree", () => {
    const repo = initRepo();
    const db = makeSettingsDb();
    const workspace = prepareTaskWorkspace(
      {
        id: "task-global",
        title: "Fallback to global",
        task_number: "#99",
        project_path: repo,
      } as never,
      null,
      db,
    );

    assert.equal(workspace.rootPath, repo);
    assert.match(workspace.branchName ?? "", /^ao\/t99-fallback-to-global$/);
    assert.equal(existsSync(workspace.cwd), true);
  });

  it("honours the db setting when it forces shared mode", () => {
    const repo = initRepo();
    const db = makeSettingsDb("shared");
    const workspace = prepareTaskWorkspace(
      {
        id: "task-shared-db",
        title: "DB-forced shared",
        task_number: "#100",
        project_path: repo,
      } as never,
      null,
      db,
    );

    assert.equal(workspace.cwd, repo);
    assert.equal(workspace.branchName, null);
  });
});

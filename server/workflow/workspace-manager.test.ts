import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { prepareTaskWorkspace, reconcileAllAoWorktrees, reconcileAoWorktrees, removeTaskWorkspace, resolveWorkspaceMode } from "./workspace-manager.js";
import { SCHEMA_SQL } from "../db/schema.js";
import { randomUUID } from "node:crypto";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-worktree-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "ao@example.com");
  git(dir, "config", "user.name", "Agent Organizer");
  writeFileSync(join(dir, "README.md"), "hello\n");
  writeFileSync(join(dir, ".gitignore"), ".ao-worktrees/\n");
  git(dir, "add", "README.md", ".gitignore");
  git(dir, "commit", "-m", "init");
  git(dir, "remote", "add", "origin", dir);
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
    assert.match(workspace.branchName ?? "", /^feat\/t42-add-workflow-support$/);
    assert.equal(existsSync(workspace.cwd), true);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branchName);
  });

  it("rejects a project_path that is not the git toplevel before creating a worktree", () => {
    const repo = initRepo();
    const child = join(repo, "workspace");
    mkdirSync(child);

    assert.throws(
      () => prepareTaskWorkspace(
        {
          id: "task-child-path",
          title: "Child path",
          task_number: "#421",
          project_path: child,
        } as never,
        {
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
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
        },
      ),
      /project_path must be the git toplevel; task_id=task-child-path/,
    );
    assert.equal(existsSync(join(repo, ".ao-worktrees", "task-child-path")), false);
  });

  it("rejects tasks whose expected repository_url does not match project_path origin", () => {
    const repo = initRepo();

    assert.throws(
      () => prepareTaskWorkspace(
        {
          id: "task-mismatch",
          title: "Remote mismatch",
          task_number: "#422",
          project_path: repo,
          repository_url: "https://github.com/example/other-repo",
        } as never,
        {
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
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
        },
      ),
      /repository_url does not match project_path origin; task_id=task-mismatch/,
    );
  });

  it("does not move dirty non-main branch changes into the task worktree", () => {
    const repo = initRepo();
    git(repo, "checkout", "-b", "codex/current-thread");
    writeFileSync(join(repo, "FEATURE.md"), "committed branch-only change\n");
    git(repo, "add", "FEATURE.md");
    git(repo, "commit", "-m", "feature branch work");
    writeFileSync(join(repo, "README.md"), "dirty tracked change\n");
    writeFileSync(join(repo, "UNTRACKED.md"), "dirty untracked change\n");

    const workspace = prepareTaskWorkspace(
      {
        id: "task-handoff",
        title: "Move dirty branch",
        task_number: "#43",
        project_path: repo,
      } as never,
      {
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
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
    );

    assert.match(workspace.branchName ?? "", /^feat\/t43-move-dirty-branch$/);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "codex/current-thread");
    assert.match(git(repo, "status", "--porcelain"), /README\.md/);
    assert.match(git(repo, "status", "--porcelain"), /UNTRACKED\.md/);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branchName);
    assert.equal(readFileSync(join(workspace.cwd, "README.md"), "utf-8"), "hello\n");
    assert.equal(existsSync(join(workspace.cwd, "FEATURE.md")), false);
    assert.equal(existsSync(join(workspace.cwd, "UNTRACKED.md")), false);
    assert.doesNotMatch(git(repo, "stash", "list"), /AO source handoff: task-handoff/);
  });

  it("does not move dirty main changes into a task worktree", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "README.md"), "main wip\n");

    const workspace = prepareTaskWorkspace(
      {
        id: "task-dirty-main",
        title: "Keep main local wip",
        task_number: "#45",
        project_path: repo,
      } as never,
      {
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
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
    );

    assert.match(workspace.branchName ?? "", /^feat\/t45-keep-main-local-wip$/);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(readFileSync(join(repo, "README.md"), "utf-8"), "main wip\n");
    assert.equal(readFileSync(join(workspace.cwd, "README.md"), "utf-8"), "hello\n");
    assert.match(git(repo, "status", "--porcelain"), /README\.md/);
    assert.doesNotMatch(git(repo, "stash", "list"), /AO source handoff: task-dirty-main/);
  });

  it("stashes existing worktree changes before checking out the task branch", () => {
    const repo = initRepo();
    const task = {
      id: "task-existing-worktree",
      title: "Existing worktree",
      task_number: "#44",
      project_path: repo,
    } as never;
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
      projectType: "generic" as const,
      checkTypesCmd: null,
      checkLintCmd: null,
      checkTestsCmd: null,
      checkE2eCmd: null,
    };
    const workspace = prepareTaskWorkspace(task, workflow);

    git(workspace.cwd, "checkout", "-b", "temporary-worktree-branch");
    writeFileSync(join(workspace.cwd, "WIP.md"), "worktree wip\n");

    const preparedAgain = prepareTaskWorkspace(task, workflow);

    assert.equal(preparedAgain.cwd, workspace.cwd);
    assert.equal(
      git(preparedAgain.cwd, "rev-parse", "--abbrev-ref", "HEAD"),
      preparedAgain.branchName,
    );
    assert.equal(readFileSync(join(preparedAgain.cwd, "WIP.md"), "utf-8"), "worktree wip\n");
    assert.doesNotMatch(git(repo, "stash", "list"), /AO worktree handoff: task-existing-worktree/);
  });

  it("rejects an existing task worktree that belongs to a different repository", () => {
    const expectedRepo = initRepo();
    const foreignRepo = initRepo();
    const taskId = "task-foreign-worktree";
    const foreignPath = join(expectedRepo, ".ao-worktrees", taskId);
    mkdirSync(join(expectedRepo, ".ao-worktrees"), { recursive: true });
    git(foreignRepo, "worktree", "add", "-b", "foreign/task", foreignPath, "main");

    assert.throws(
      () => prepareTaskWorkspace(
        {
          id: taskId,
          title: "Foreign worktree",
          task_number: "#444",
          project_path: expectedRepo,
        } as never,
        {
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
          projectType: "generic" as const,
          checkTypesCmd: null,
          checkLintCmd: null,
          checkTestsCmd: null,
          checkE2eCmd: null,
        },
      ),
      /repository_url does not match project_path origin; task_id=task-foreign-worktree/,
    );
  });

  it("uses a configured conventional branch prefix when provided", () => {
    const repo = initRepo();
    const workspace = prepareTaskWorkspace(
      {
        id: "task-configured-prefix",
        title: "Improve dashboard polish",
        task_number: "#46",
        project_path: repo,
      } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write" as const,
        codexApprovalPolicy: "on-request" as const,
        e2eExecution: "host" as const,
        e2eCommand: null,
        gitWorkflow: "default" as const,
        workspaceMode: "git-worktree" as const,
        branchPrefix: "refactor",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
        enableRefinement: null,
        enableTestGeneration: false,
        enableHumanReview: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
    );

    assert.match(workspace.branchName ?? "", /^refactor\/t46-improve-dashboard-polish$/);
  });

  it("trims a trailing hyphen when the slug is cut at the length limit", () => {
    const repo = initRepo();
    const workspace = prepareTaskWorkspace(
      {
        id: "task-trailing-hyphen",
        title: "Amazon transfers postgres incremental sync high-priority",
        task_number: "#460",
        project_path: repo,
      } as never,
      {
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
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      },
    );

    assert.equal(workspace.branchName, "feat/t460-amazon-transfers-postgres-incremental-sync-high");
    assert.doesNotMatch(workspace.branchName ?? "", /-$/);
  });

  it("reuses an existing worktree even when the old branch name ended with a trailing hyphen", () => {
    const repo = initRepo();
    const task = {
      id: "task-existing-truncated-branch",
      title: "Amazon transfers postgres incremental sync high-priority",
      task_number: "#460",
      project_path: repo,
    } as never;
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
      projectType: "generic" as const,
      checkTypesCmd: null,
      checkLintCmd: null,
      checkTestsCmd: null,
      checkE2eCmd: null,
    };
    const worktreePath = join(repo, ".ao-worktrees", "task-existing-truncated-branch");
    const brokenBranch = "feat/t460-amazon-transfers-postgres-incremental-sync-high-";
    const fixedBranch = "feat/t460-amazon-transfers-postgres-incremental-sync-high";

    git(repo, "worktree", "add", "-b", brokenBranch, worktreePath, "main");

    const workspace = prepareTaskWorkspace(task, workflow);

    assert.equal(workspace.cwd, worktreePath);
    assert.equal(workspace.branchName, fixedBranch);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), fixedBranch);
    assert.equal(git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${fixedBranch}`), "");
  });

  it("infers docs/fix/chore/ci branch prefixes from task text", () => {
    const repo = initRepo();
    const docsWorkspace = prepareTaskWorkspace(
      {
        id: "task-docs-prefix",
        title: "Update README usage docs",
        task_number: "#47",
        project_path: repo,
      } as never,
      null,
    );
    const fixWorkspace = prepareTaskWorkspace(
      {
        id: "task-fix-prefix",
        title: "Fix Activity transition bug",
        task_number: "#48",
        project_path: repo,
      } as never,
      null,
    );
    const choreWorkspace = prepareTaskWorkspace(
      {
        id: "task-chore-prefix",
        title: "Update dependency config",
        task_number: "#49",
        project_path: repo,
      } as never,
      null,
    );
    const ciWorkspace = prepareTaskWorkspace(
      {
        id: "task-ci-prefix",
        title: "Update GitHub Actions workflow file",
        task_number: "#50",
        project_path: repo,
      } as never,
      null,
    );

    assert.match(docsWorkspace.branchName ?? "", /^docs\/t47-update-readme-usage-docs$/);
    assert.match(fixWorkspace.branchName ?? "", /^fix\/t48-fix-activity-transition-bug$/);
    assert.match(choreWorkspace.branchName ?? "", /^chore\/t49-update-dependency-config$/);
    assert.match(ciWorkspace.branchName ?? "", /^ci\/t50-update-github-actions-workflow-file$/);
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
    assert.match(workspace.branchName ?? "", /^feat\/t99-fallback-to-global$/);
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

describe("prepareTaskWorkspace — origin/main enforcement", () => {
  it("bases the worktree on the latest origin/main when origin is configured", () => {
    // Set up an "upstream" bare-like source repo + a local clone. Any
    // commits advanced on the upstream between clone-time and worktree-
    // creation must be picked up automatically via the implicit fetch.
    const upstream = initRepo();
    const localDir = mkdtempSync(join(tmpdir(), "ao-worktree-clone-"));
    execFileSync("git", ["clone", upstream, localDir], { stdio: ["ignore", "pipe", "pipe"] });
    git(localDir, "config", "user.email", "ao@example.com");
    git(localDir, "config", "user.name", "Agent Organizer");

    // Advance upstream main with a new commit after the clone.
    writeFileSync(join(upstream, "NEW.md"), "new file\n");
    git(upstream, "add", "NEW.md");
    git(upstream, "commit", "-m", "upstream advance");
    const upstreamHead = git(upstream, "rev-parse", "HEAD");

    const workflow = {
      body: "",
      codexSandboxMode: "workspace-write" as const,
      codexApprovalPolicy: "on-request" as const,
      e2eExecution: "host" as const,
      e2eCommand: null,
      gitWorkflow: "default" as const,
      workspaceMode: "git-worktree" as const,
      branchPrefix: "ao",
      beforeRun: [],
      afterRun: [],
      includeTask: true,
      includeReview: true,
      includeDecompose: true,
      enableRefinement: null,
      enableTestGeneration: false,
      enableHumanReview: false,
      projectType: "generic" as const,
      checkTypesCmd: null,
      checkLintCmd: null,
      checkTestsCmd: null,
      checkE2eCmd: null,
    };

    const workspace = prepareTaskWorkspace(
      {
        id: "task-origin-main",
        title: "Based on origin main",
        task_number: "#77",
        project_path: localDir,
      } as never,
      workflow,
    );

    // The worktree HEAD must match the upstream tip, proving fetch+rebase-to-origin
    // happened rather than using the pre-fetch local ref.
    const worktreeHead = git(workspace.cwd, "rev-parse", "HEAD");
    assert.equal(worktreeHead, upstreamHead);
  });

  it("rejects git-worktree mode when origin remote is missing", () => {
    const repo = initRepo();
    git(repo, "remote", "remove", "origin");

    assert.throws(
      () => prepareTaskWorkspace(
      {
        id: "task-no-origin",
        title: "No origin",
        task_number: "#78",
        project_path: repo,
      } as never,
      {
        body: "",
        codexSandboxMode: "workspace-write",
        codexApprovalPolicy: "on-request",
        e2eExecution: "host",
        e2eCommand: null,
        gitWorkflow: "default",
        workspaceMode: "git-worktree",
        branchPrefix: "ao",
        beforeRun: [],
        afterRun: [],
        includeTask: true,
        includeReview: true,
        includeDecompose: true,
        enableRefinement: null,
        enableTestGeneration: false,
        enableHumanReview: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      } as never,
      ),
      /repository_url could not be auto-detected from origin/,
    );
  });
});

describe("removeTaskWorkspace", () => {
  const buildWorkflow = () => ({
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
    projectType: "generic" as const,
    checkTypesCmd: null,
    checkLintCmd: null,
    checkTestsCmd: null,
    checkE2eCmd: null,
  });

  it("removes the worktree directory and deletes the branch when both exist", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const task = {
      id: "task-remove-1",
      title: "Cleanup task",
      task_number: "#42",
      project_path: repo,
    } as never;

    const workspace = prepareTaskWorkspace(task, workflow);
    assert.equal(existsSync(workspace.cwd), true, "precondition: worktree exists");
    const branchName = workspace.branchName!;
    assert.match(
      git(repo, "branch", "--list", branchName),
      new RegExp(branchName),
      "precondition: branch exists",
    );

    const result = removeTaskWorkspace(task, workflow);

    assert.equal(result.removed, true);
    assert.equal(result.branchDeleted, true);
    assert.equal(existsSync(workspace.cwd), false, "worktree directory should be gone");
    assert.equal(
      git(repo, "branch", "--list", branchName),
      "",
      "branch should be deleted",
    );
  });

  it("returns not-a-git-repo when the project_path is not a git repository", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ao-remove-non-git-"));
    const result = removeTaskWorkspace(
      {
        id: "task-no-git",
        title: "X",
        task_number: "#1",
        project_path: tempDir,
      } as never,
      buildWorkflow(),
    );
    assert.equal(result.removed, false);
    assert.equal(result.reason, "not-a-git-repo");
  });

  it("returns worktree-not-found when no .ao-worktrees entry exists for the task", () => {
    const repo = initRepo();
    const result = removeTaskWorkspace(
      {
        id: "task-never-prepared",
        title: "X",
        task_number: "#1",
        project_path: repo,
      } as never,
      buildWorkflow(),
    );
    assert.equal(result.removed, false);
    assert.equal(result.reason, "worktree-not-found");
  });

  it("preserves the branch when deleteBranch is false", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const task = {
      id: "task-keep-branch",
      title: "Cleanup task",
      task_number: "#7",
      project_path: repo,
    } as never;

    const workspace = prepareTaskWorkspace(task, workflow);
    const branchName = workspace.branchName!;

    const result = removeTaskWorkspace(task, workflow, { deleteBranch: false });

    assert.equal(result.removed, true);
    assert.equal(result.branchDeleted, false);
    assert.equal(existsSync(workspace.cwd), false);
    assert.match(
      git(repo, "branch", "--list", branchName),
      new RegExp(branchName),
      "branch should still exist",
    );
  });

  it("preserves a branch with unpushed commits even when deleteBranch is true", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const task = {
      id: "task-unpushed",
      title: "Has unpushed work",
      task_number: "#9",
      project_path: repo,
    } as never;

    const workspace = prepareTaskWorkspace(task, workflow);
    const branchName = workspace.branchName!;

    // Create a commit on the task branch — main has no remote tracking
    // counterpart, so `git branch -D` will refuse to drop a branch
    // holding commits not reachable from upstream.
    writeFileSync(join(workspace.cwd, "WORK.md"), "in progress\n");
    git(workspace.cwd, "add", "WORK.md");
    git(workspace.cwd, "commit", "-m", "wip");

    const result = removeTaskWorkspace(task, workflow);

    assert.equal(result.removed, true, "worktree directory must still be removed");
    assert.equal(result.branchDeleted, false, "branch with unpushed work is preserved");
    assert.equal(existsSync(workspace.cwd), false);
    assert.match(
      git(repo, "branch", "--list", branchName),
      new RegExp(branchName),
      "branch must remain so unpushed work can be recovered",
    );
  });
});

describe("reconcileAoWorktrees", () => {
  const buildWorkflow = () => ({
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
    projectType: "generic" as const,
    checkTypesCmd: null,
    checkLintCmd: null,
    checkTestsCmd: null,
    checkE2eCmd: null,
  });

  function createDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    return db;
  }

  function insertTaskRow(
    db: DatabaseSync,
    id: string,
    status: string,
    title = "Some task",
    taskNumber: string | null = null,
  ): void {
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, project_path, status,
        priority, task_size, task_number, depends_on, result, review_count,
        started_at, completed_at, created_at, updated_at,
        directive_id, pr_url, external_source, external_id, interactive_prompt_data,
        review_branch, review_commit_sha, review_sync_status, review_sync_error
      ) VALUES (?, ?, NULL, NULL, NULL, ?, 0, 'medium', ?, NULL, NULL, 0,
                NULL, NULL, 1000, 1000,
                NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, 'pending', NULL)`,
    ).run(id, title, status, taskNumber);
  }

  it("removes worktrees for done tasks and orphans, keeps active tasks", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();

    const doneId = randomUUID();
    const orphanId = randomUUID();
    const activeId = randomUUID();
    const inboxId = randomUUID();

    insertTaskRow(db, doneId, "done", "Finished work", "#1");
    // orphan: intentionally NOT inserted into DB
    insertTaskRow(db, activeId, "in_progress", "Running work", "#2");
    insertTaskRow(db, inboxId, "inbox", "Pending work", "#3");

    // Create worktrees for all four (orphan needs a fake task object)
    prepareTaskWorkspace({ id: doneId, title: "Finished work", task_number: "#1", project_path: repo } as never, workflow);
    prepareTaskWorkspace({ id: orphanId, title: "Orphan work", task_number: "#9", project_path: repo } as never, workflow);
    prepareTaskWorkspace({ id: activeId, title: "Running work", task_number: "#2", project_path: repo } as never, workflow);
    prepareTaskWorkspace({ id: inboxId, title: "Pending work", task_number: "#3", project_path: repo } as never, workflow);

    const result = reconcileAoWorktrees(db, { cwd: repo });

    assert.equal(result.scanned, 4);
    assert.equal(result.removed.length, 2);
    assert.equal(result.kept.length, 2);
    assert.equal(result.preserved.length, 0);

    const removedIds = result.removed.map((r) => r.taskId).sort();
    assert.deepEqual(removedIds, [doneId, orphanId].sort());
    assert.deepEqual(
      result.removed.map((r) => r.reason).sort(),
      ["done", "orphan"],
    );

    assert.deepEqual(
      result.kept.map((k) => k.status).sort(),
      ["in_progress", "inbox"].sort(),
    );

    assert.equal(existsSync(join(repo, ".ao-worktrees", doneId)), false);
    assert.equal(existsSync(join(repo, ".ao-worktrees", orphanId)), false);
    assert.equal(existsSync(join(repo, ".ao-worktrees", activeId)), true);
    assert.equal(existsSync(join(repo, ".ao-worktrees", inboxId)), true);
  });

  it("keeps cancelled worktrees by default", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();
    const id = randomUUID();
    insertTaskRow(db, id, "cancelled", "Stopped work", "#10");
    prepareTaskWorkspace({ id, title: "Stopped work", task_number: "#10", project_path: repo } as never, workflow);

    const result = reconcileAoWorktrees(db, { cwd: repo });
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0]?.status, "cancelled");
    assert.equal(existsSync(join(repo, ".ao-worktrees", id)), true);
  });

  it("removes cancelled worktrees when removeCancelled is true", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();
    const id = randomUUID();
    insertTaskRow(db, id, "cancelled", "Stopped work", "#11");
    prepareTaskWorkspace({ id, title: "Stopped work", task_number: "#11", project_path: repo } as never, workflow);

    const result = reconcileAoWorktrees(db, { cwd: repo, removeCancelled: true });
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0]?.reason, "cancelled");
    assert.equal(existsSync(join(repo, ".ao-worktrees", id)), false);
  });

  it("preserves a stale worktree whose branch holds unpushed commits", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();

    const id = randomUUID();
    insertTaskRow(db, id, "done", "Has unpushed wip", "#5");
    const ws = prepareTaskWorkspace(
      { id, title: "Has unpushed wip", task_number: "#5", project_path: repo } as never,
      workflow,
    );

    writeFileSync(join(ws.cwd, "WIP.md"), "in progress\n");
    git(ws.cwd, "add", "WIP.md");
    git(ws.cwd, "commit", "-m", "wip");

    const result = reconcileAoWorktrees(db, { cwd: repo });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed.length, 0);
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0]?.reason, "unpushed-commits");
    assert.equal(existsSync(ws.cwd), true, "worktree must remain so the unpushed commit can be recovered");
  });

  it("returns an empty result when .ao-worktrees does not exist", () => {
    const repo = initRepo();
    const db = createDb();

    const result = reconcileAoWorktrees(db, { cwd: repo });

    assert.equal(result.scanned, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(result.kept.length, 0);
    assert.equal(result.preserved.length, 0);
  });

  it("scans filesystem-only .ao-worktrees directories that git worktree list misses", () => {
    const repo = initRepo();
    const db = createDb();
    const orphanId = randomUUID();
    const orphanPath = join(repo, ".ao-worktrees", orphanId);
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, "NOTE.md"), "stale directory\n");

    const result = reconcileAoWorktrees(db, { cwd: repo });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed.length, 1);
    assert.equal(result.removed[0]?.taskId, orphanId);
    assert.equal(existsSync(orphanPath), false);
  });

  it("preserves filesystem-only git worktrees for manual cleanup", () => {
    const repo = initRepo();
    const foreignRepo = initRepo();
    const db = createDb();
    const foreignId = randomUUID();
    const foreignPath = join(repo, ".ao-worktrees", foreignId);
    mkdirSync(join(repo, ".ao-worktrees"), { recursive: true });
    git(foreignRepo, "worktree", "add", "-b", `foreign/${foreignId}`, foreignPath, "main");

    const result = reconcileAoWorktrees(db, { cwd: repo });

    assert.equal(result.scanned, 1);
    assert.equal(result.removed.length, 0);
    assert.equal(result.preserved.length, 1);
    assert.equal(result.preserved[0]?.taskId, foreignId);
    assert.match(result.preserved[0]?.details ?? "", /not registered in this repository/);
    assert.equal(existsSync(foreignPath), true);
  });

  it("returns an empty result when cwd is not a git repository", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ao-reconcile-non-git-"));
    const db = createDb();

    const result = reconcileAoWorktrees(db, { cwd: tempDir });

    assert.equal(result.scanned, 0);
    assert.equal(result.removed.length, 0);
  });

  it("dedupes project_paths that resolve to the same repo root (symlink / subdir)", () => {
    const repo = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();

    const doneId = randomUUID();
    insertTaskRow(db, doneId, "done", "Finished work", "#1");
    db.prepare("UPDATE tasks SET project_path = ? WHERE id = ?").run(repo, doneId);
    prepareTaskWorkspace({ id: doneId, title: "Finished work", task_number: "#1", project_path: repo } as never, workflow);

    // Insert a second task whose project_path points to a subdirectory
    // inside the same repo. `git rev-parse --show-toplevel` resolves it
    // back to `repo`, so without dedup the same worktree would be
    // counted twice.
    const subdir = join(repo, ".ao-worktrees");
    const otherId = randomUUID();
    insertTaskRow(db, otherId, "in_progress", "Active work", "#2");
    db.prepare("UPDATE tasks SET project_path = ? WHERE id = ?").run(subdir, otherId);

    const result = reconcileAllAoWorktrees(db);

    assert.equal(result.projects, 1, "the same repo must only be visited once");
    assert.equal(result.scanned, 1);
    assert.equal(result.removed.length, 1);
  });

  it("aggregates reconcile across every distinct project_path in the tasks table", () => {
    const repoA = initRepo();
    const repoB = initRepo();
    const workflow = buildWorkflow();
    const db = createDb();

    // repoA has one done task → expect removal
    const doneA = randomUUID();
    insertTaskRow(db, doneA, "done", "Finished A", "#1");
    db.prepare("UPDATE tasks SET project_path = ? WHERE id = ?").run(repoA, doneA);
    prepareTaskWorkspace({ id: doneA, title: "Finished A", task_number: "#1", project_path: repoA } as never, workflow);

    // repoB has one active task → expect kept
    const activeB = randomUUID();
    insertTaskRow(db, activeB, "in_progress", "Working B", "#2");
    db.prepare("UPDATE tasks SET project_path = ? WHERE id = ?").run(repoB, activeB);
    prepareTaskWorkspace({ id: activeB, title: "Working B", task_number: "#2", project_path: repoB } as never, workflow);

    // repoB also has an orphan worktree (DB row never inserted) → expect removal
    const orphanB = randomUUID();
    prepareTaskWorkspace({ id: orphanB, title: "Orphan B", task_number: "#9", project_path: repoB } as never, workflow);

    const result = reconcileAllAoWorktrees(db);

    assert.equal(result.projects, 2, "both repoA and repoB should be visited");
    assert.equal(result.scanned, 3);
    assert.equal(result.removed.length, 2);
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0]?.taskId, activeB);

    const removedIds = result.removed.map((r) => r.taskId).sort();
    assert.deepEqual(removedIds, [doneA, orphanB].sort());

    assert.equal(existsSync(join(repoA, ".ao-worktrees", doneA)), false);
    assert.equal(existsSync(join(repoB, ".ao-worktrees", activeB)), true);
    assert.equal(existsSync(join(repoB, ".ao-worktrees", orphanB)), false);
  });
});

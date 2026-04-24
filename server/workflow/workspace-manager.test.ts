import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(dir, ".gitignore"), ".ao-worktrees/\n");
  git(dir, "add", "README.md", ".gitignore");
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
    assert.match(workspace.branchName ?? "", /^feat\/t42-add-workflow-support$/);
    assert.equal(existsSync(workspace.cwd), true);
    assert.equal(git(workspace.cwd, "rev-parse", "--abbrev-ref", "HEAD"), workspace.branchName);
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
        enableCiCheck: false,
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
        enableCiCheck: false,
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
      enableCiCheck: false,
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
        enableCiCheck: false,
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
        enableCiCheck: false,
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
      enableCiCheck: false,
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
      enableCiCheck: false,
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

  it("falls back to local main when no origin remote is configured", () => {
    // initRepo produces a repo with no remote — simulating minimal test fixtures.
    const repo = initRepo();
    const localMainHead = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-b", "feature/local-only-work");
    writeFileSync(join(repo, "LOCAL_ONLY.md"), "local feature branch\n");
    git(repo, "add", "LOCAL_ONLY.md");
    git(repo, "commit", "-m", "local feature branch work");

    const workspace = prepareTaskWorkspace(
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
        enableCiCheck: false,
        projectType: "generic" as const,
        checkTypesCmd: null,
        checkLintCmd: null,
        checkTestsCmd: null,
        checkE2eCmd: null,
      } as never,
    );

    const worktreeHead = git(workspace.cwd, "rev-parse", "HEAD");
    assert.equal(worktreeHead, localMainHead);
    assert.equal(existsSync(join(workspace.cwd, "LOCAL_ONLY.md")), false);
  });
});

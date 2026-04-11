import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { detectRepositoryUrl, normalizeGitUrl } from "./git-utils.js";

describe("normalizeGitUrl", () => {
  it("returns null for empty / nullish input", () => {
    assert.equal(normalizeGitUrl(""), null);
    assert.equal(normalizeGitUrl("   "), null);
    assert.equal(normalizeGitUrl(null), null);
    assert.equal(normalizeGitUrl(undefined), null);
  });

  describe("SSH shorthand (git@host:user/repo)", () => {
    it("converts to https and strips .git", () => {
      assert.equal(
        normalizeGitUrl("git@github.com:1neoneo3/agent-organizer.git"),
        "https://github.com/1neoneo3/agent-organizer",
      );
    });

    it("handles shorthand without .git suffix", () => {
      assert.equal(
        normalizeGitUrl("git@github.com:1neoneo3/agent-organizer"),
        "https://github.com/1neoneo3/agent-organizer",
      );
    });

    it("handles nested paths (e.g. gitlab groups)", () => {
      assert.equal(
        normalizeGitUrl("git@gitlab.com:group/subgroup/project.git"),
        "https://gitlab.com/group/subgroup/project",
      );
    });

    it("handles non-github hosts", () => {
      assert.equal(
        normalizeGitUrl("git@bitbucket.org:team/repo.git"),
        "https://bitbucket.org/team/repo",
      );
    });
  });

  describe("SSH scheme (ssh://...)", () => {
    it("converts ssh:// to https", () => {
      assert.equal(
        normalizeGitUrl("ssh://git@github.com/1neoneo3/agent-organizer.git"),
        "https://github.com/1neoneo3/agent-organizer",
      );
    });

    it("handles ssh:// without user", () => {
      assert.equal(
        normalizeGitUrl("ssh://github.com/1neoneo3/repo.git"),
        "https://github.com/1neoneo3/repo",
      );
    });

    it("handles git+ssh://", () => {
      assert.equal(
        normalizeGitUrl("git+ssh://git@github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    it("handles git:// protocol", () => {
      assert.equal(
        normalizeGitUrl("git://github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });
  });

  describe("HTTPS / HTTP", () => {
    it("strips trailing .git from https", () => {
      assert.equal(
        normalizeGitUrl("https://github.com/user/repo.git"),
        "https://github.com/user/repo",
      );
    });

    it("leaves https without .git untouched", () => {
      assert.equal(
        normalizeGitUrl("https://github.com/user/repo"),
        "https://github.com/user/repo",
      );
    });

    it("preserves http:// scheme", () => {
      assert.equal(
        normalizeGitUrl("http://internal.example.com/git/repo.git"),
        "http://internal.example.com/git/repo",
      );
    });

    it("handles urls with username", () => {
      assert.equal(
        normalizeGitUrl("https://token@github.com/user/repo.git"),
        "https://token@github.com/user/repo",
      );
    });
  });

  it("returns null for obviously wrong input", () => {
    assert.equal(normalizeGitUrl("not a url"), null);
    assert.equal(normalizeGitUrl("/some/local/path"), null);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(
      normalizeGitUrl("  https://github.com/user/repo.git\n"),
      "https://github.com/user/repo",
    );
  });
});

describe("detectRepositoryUrl", () => {
  function initGitRepo(dir: string, origin: string): void {
    spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "remote", "add", "origin", origin], {
      encoding: "utf8",
    });
  }

  it("returns the normalized origin for a git toplevel", () => {
    const root = mkdtempSync(join(tmpdir(), "ao-git-"));
    initGitRepo(root, "git@github.com:acme/widget.git");
    assert.equal(detectRepositoryUrl(root), "https://github.com/acme/widget");
  });

  it("returns null when the path is NOT the git toplevel", () => {
    // A common misfire: projectPath is a subdirectory that happens to sit
    // under an unrelated parent repo. git walks up and finds origin, but
    // that origin does not describe the project at all.
    const parent = mkdtempSync(join(tmpdir(), "ao-git-parent-"));
    initGitRepo(parent, "git@github.com:unrelated/parent-repo.git");
    const child = join(parent, "subproject");
    mkdirSync(child);
    assert.equal(detectRepositoryUrl(child), null);
  });

  it("returns null for a non-git path", () => {
    const plain = mkdtempSync(join(tmpdir(), "ao-git-none-"));
    assert.equal(detectRepositoryUrl(plain), null);
  });

  it("returns null for a missing path", () => {
    assert.equal(detectRepositoryUrl("/definitely/not/a/real/path/xyz"), null);
  });

  it("returns null for empty input", () => {
    assert.equal(detectRepositoryUrl(""), null);
  });
});

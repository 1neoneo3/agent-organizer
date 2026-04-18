import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SCHEMA_SQL } from "../db/schema.js";
import {
  findTasksByPrUrl,
  handleMergedPrEvent,
  isPullRequestMergedEvent,
  recordMergeAndMaybeComplete,
  verifyGithubSignature,
} from "./github.js";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function insertTask(
  db: DatabaseSync,
  opts: {
    id: string;
    task_number?: string;
    status?: string;
    pr_url?: string | null;
    pr_urls?: string[] | null;
    merged_pr_urls?: string[] | null;
    depends_on?: string[] | null;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, task_size, task_number, pr_url, pr_urls, merged_pr_urls, depends_on)
     VALUES (?, ?, ?, 'small', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    `task ${opts.task_number ?? opts.id}`,
    opts.status ?? "pr_review",
    opts.task_number ?? null,
    opts.pr_url ?? null,
    opts.pr_urls ? JSON.stringify(opts.pr_urls) : null,
    opts.merged_pr_urls ? JSON.stringify(opts.merged_pr_urls) : null,
    opts.depends_on ? JSON.stringify(opts.depends_on) : null,
  );
}

describe("verifyGithubSignature", () => {
  it("returns true when no secret is configured (dev mode)", () => {
    assert.equal(verifyGithubSignature("", Buffer.from("{}"), "sha256=ignored"), true);
  });

  it("accepts a correctly signed payload", () => {
    const body = Buffer.from('{"action":"closed"}');
    const secret = "testsecret";
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    assert.equal(verifyGithubSignature(secret, body, sig), true);
  });

  it("rejects a wrong signature", () => {
    const body = Buffer.from('{"action":"closed"}');
    assert.equal(
      verifyGithubSignature("testsecret", body, "sha256=" + "0".repeat(64)),
      false,
    );
  });

  it("rejects missing / malformed signature header", () => {
    const body = Buffer.from('{}');
    assert.equal(verifyGithubSignature("s", body, undefined), false);
    assert.equal(verifyGithubSignature("s", body, "md5=xxxx"), false);
  });
});

describe("isPullRequestMergedEvent", () => {
  it("returns true for pull_request.closed with merged:true", () => {
    assert.equal(
      isPullRequestMergedEvent("pull_request", {
        action: "closed",
        pull_request: { merged: true, html_url: "https://example/pr/1" },
      }),
      true,
    );
  });

  it("ignores action=opened", () => {
    assert.equal(
      isPullRequestMergedEvent("pull_request", {
        action: "opened",
        pull_request: { merged: false, html_url: "https://example/pr/1" },
      }),
      false,
    );
  });

  it("ignores merged:false (PR closed without merge)", () => {
    assert.equal(
      isPullRequestMergedEvent("pull_request", {
        action: "closed",
        pull_request: { merged: false, html_url: "https://example/pr/1" },
      }),
      false,
    );
  });

  it("ignores non-pull_request events", () => {
    assert.equal(
      isPullRequestMergedEvent("push", {
        action: "closed",
        pull_request: { merged: true, html_url: "https://example/pr/1" },
      }),
      false,
    );
  });

  it("ignores payloads missing html_url", () => {
    assert.equal(
      isPullRequestMergedEvent("pull_request", {
        action: "closed",
        pull_request: { merged: true },
      }),
      false,
    );
  });
});

describe("findTasksByPrUrl", () => {
  const URL1 = "https://github.com/acme/repo/pull/1";
  const URL2 = "https://github.com/acme/repo/pull/2";

  it("finds task whose pr_url matches exactly", () => {
    const db = createDb();
    insertTask(db, { id: "t1", task_number: "#1", pr_url: URL1 });
    const hits = findTasksByPrUrl(db, URL1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "t1");
  });

  it("finds task whose pr_urls JSON array contains the URL", () => {
    const db = createDb();
    insertTask(db, { id: "t2", task_number: "#2", pr_urls: [URL1, URL2] });
    const hits = findTasksByPrUrl(db, URL2);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "t2");
  });

  it("skips tasks already in done / cancelled", () => {
    const db = createDb();
    insertTask(db, { id: "done", pr_url: URL1, status: "done" });
    insertTask(db, { id: "cx", pr_url: URL1, status: "cancelled" });
    assert.deepStrictEqual(findTasksByPrUrl(db, URL1), []);
  });

  it("does not false-match on URL substrings (pr/10 vs pr/1)", () => {
    const db = createDb();
    insertTask(db, { id: "t10", pr_url: URL1 + "0" }); // /pr/10
    const hits = findTasksByPrUrl(db, URL1);
    assert.deepStrictEqual(hits, []);
  });
});

describe("recordMergeAndMaybeComplete — single PR", () => {
  const URL = "https://github.com/acme/repo/pull/1";

  it("transitions single-PR task directly to done", () => {
    const db = createDb();
    insertTask(db, { id: "t", task_number: "#1", pr_url: URL, status: "pr_review" });
    const task = db
      .prepare("SELECT id, task_number, status, pr_url, pr_urls, merged_pr_urls, result FROM tasks WHERE id = 't'")
      .get() as any;
    const res = recordMergeAndMaybeComplete(db, task, URL, "abc123", 1700000000000);
    assert.equal(res.all_merged, true);
    assert.equal(res.after_status, "done");

    const after = db.prepare("SELECT status, result, completed_at FROM tasks WHERE id = 't'").get() as any;
    assert.equal(after.status, "done");
    assert.match(after.result as string, /Merged:.*pull\/1/);
    assert.match(after.result as string, /abc123/);
    assert.equal(after.completed_at, 1700000000000);
  });
});

describe("recordMergeAndMaybeComplete — multi PR", () => {
  const URL1 = "https://github.com/acme/repo/pull/1";
  const URL2 = "https://github.com/acme/repo/pull/2";

  it("first merge records URL but does NOT complete the task", () => {
    const db = createDb();
    insertTask(db, { id: "t", task_number: "#1", pr_urls: [URL1, URL2], status: "pr_review" });
    const task = db
      .prepare("SELECT id, task_number, status, pr_url, pr_urls, merged_pr_urls, result FROM tasks WHERE id = 't'")
      .get() as any;
    const res = recordMergeAndMaybeComplete(db, task, URL1, "aaa", 1_700_000_000_000);
    assert.equal(res.all_merged, false);
    assert.deepStrictEqual(res.merged_pr_urls, [URL1]);

    const after = db.prepare("SELECT status, merged_pr_urls FROM tasks WHERE id = 't'").get() as any;
    assert.equal(after.status, "pr_review"); // unchanged
    assert.deepStrictEqual(JSON.parse(after.merged_pr_urls), [URL1]);
  });

  it("second merge completes the task once every pr_urls entry is merged", () => {
    const db = createDb();
    insertTask(db, {
      id: "t",
      task_number: "#1",
      pr_urls: [URL1, URL2],
      merged_pr_urls: [URL1], // first PR already recorded
      status: "pr_review",
    });
    const task = db
      .prepare("SELECT id, task_number, status, pr_url, pr_urls, merged_pr_urls, result FROM tasks WHERE id = 't'")
      .get() as any;
    const res = recordMergeAndMaybeComplete(db, task, URL2, "bbb", 1_700_000_000_000);
    assert.equal(res.all_merged, true);
    assert.equal(res.after_status, "done");

    const after = db.prepare("SELECT status, merged_pr_urls FROM tasks WHERE id = 't'").get() as any;
    assert.equal(after.status, "done");
    assert.deepStrictEqual(JSON.parse(after.merged_pr_urls).sort(), [URL1, URL2].sort());
  });

  it("is idempotent on duplicate webhook delivery", () => {
    const db = createDb();
    insertTask(db, {
      id: "t",
      pr_urls: [URL1, URL2],
      merged_pr_urls: [URL1],
      status: "pr_review",
    });
    const task = db
      .prepare("SELECT id, task_number, status, pr_url, pr_urls, merged_pr_urls, result FROM tasks WHERE id = 't'")
      .get() as any;
    // Receive URL1 again
    const res = recordMergeAndMaybeComplete(db, task, URL1, "aaa");
    assert.equal(res.all_merged, false);
    assert.deepStrictEqual(res.merged_pr_urls, [URL1]); // no duplicate
  });
});

describe("handleMergedPrEvent", () => {
  const URL = "https://github.com/acme/repo/pull/42";

  it("matches all tasks pointing at the merged PR and fires onCompletion once", () => {
    const db = createDb();
    insertTask(db, { id: "t1", task_number: "#1", pr_url: URL, status: "pr_review" });
    insertTask(db, { id: "t2", task_number: "#2", pr_urls: [URL], status: "pr_review" });
    let completionFired = 0;
    const logs: Array<[string, string]> = [];
    const broadcasts: string[] = [];

    const res = handleMergedPrEvent(
      db,
      {
        action: "closed",
        pull_request: { html_url: URL, merged: true, merge_commit_sha: "deadbeef" },
      },
      {
        log: (id, msg) => logs.push([id, msg]),
        broadcastTaskUpdate: (id) => broadcasts.push(id),
        onCompletion: () => {
          completionFired += 1;
        },
      },
    );
    assert.equal(res.matched.length, 2);
    assert.equal(res.completed_task_ids.length, 2);
    assert.equal(completionFired, 1, "onCompletion runs once even with multiple completed tasks");
    assert.deepStrictEqual(broadcasts.sort(), ["t1", "t2"]);
    assert.ok(logs.every(([, m]) => m.includes("deadbeef")));

    for (const id of ["t1", "t2"]) {
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as any;
      assert.equal(row.status, "done");
    }
  });

  it("does NOT fire onCompletion when every match is partial-only", () => {
    const db = createDb();
    insertTask(db, { id: "t", pr_urls: [URL, "https://example/pr/99"], status: "pr_review" });
    let completionFired = 0;
    const res = handleMergedPrEvent(
      db,
      { action: "closed", pull_request: { html_url: URL, merged: true } },
      { onCompletion: () => (completionFired += 1) },
    );
    assert.equal(res.completed_task_ids.length, 0);
    assert.equal(completionFired, 0);
    const row = db.prepare("SELECT status FROM tasks WHERE id = 't'").get() as any;
    assert.equal(row.status, "pr_review");
  });

  it("returns an empty result when no task references the URL", () => {
    const db = createDb();
    insertTask(db, { id: "t", pr_url: "https://other/pr/1", status: "pr_review" });
    const res = handleMergedPrEvent(db, {
      action: "closed",
      pull_request: { html_url: URL, merged: true },
    });
    assert.deepStrictEqual(res.matched, []);
    assert.deepStrictEqual(res.completed_task_ids, []);
  });
});

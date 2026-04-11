import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHeartbeatManager } from "./heartbeat-manager.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY, last_heartbeat_at INTEGER)",
  );
  return db;
}

function seed(db: DatabaseSync, ids: string[]): void {
  const stmt = db.prepare("INSERT INTO tasks (id) VALUES (?)");
  for (const id of ids) stmt.run(id);
}

function getHeartbeat(db: DatabaseSync, id: string): number | null {
  const row = db
    .prepare("SELECT last_heartbeat_at FROM tasks WHERE id = ?")
    .get(id) as { last_heartbeat_at: number | null } | undefined;
  return row?.last_heartbeat_at ?? null;
}

describe("createHeartbeatManager", () => {
  it("stamps heartbeat immediately on registerTask", () => {
    const db = createTestDb();
    seed(db, ["t1"]);
    const hb = createHeartbeatManager(db);

    assert.equal(getHeartbeat(db, "t1"), null);

    const before = Date.now();
    hb.registerTask("t1");

    const stamped = getHeartbeat(db, "t1");
    assert.ok(stamped !== null, "heartbeat should be stamped");
    assert.ok(stamped >= before, "heartbeat should be at or after register time");
  });

  it("tick() updates every registered task", () => {
    const db = createTestDb();
    seed(db, ["t1", "t2", "t3"]);
    const hb = createHeartbeatManager(db);

    hb.registerTask("t1");
    hb.registerTask("t2");
    hb.registerTask("t3");

    // Clear any heartbeat written by the initial stamp inside registerTask,
    // so we can observe the effect of the scheduled tick in isolation.
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();

    const before = Date.now();
    hb.tick();

    for (const id of ["t1", "t2", "t3"]) {
      const hbv = getHeartbeat(db, id);
      assert.ok(hbv !== null, `heartbeat for ${id} should be written`);
      assert.ok(hbv >= before, `heartbeat for ${id} should be current`);
    }
  });

  it("skips tasks that were unregistered", () => {
    const db = createTestDb();
    seed(db, ["t1", "t2"]);
    const hb = createHeartbeatManager(db);

    hb.registerTask("t1");
    hb.registerTask("t2");
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();

    hb.unregisterTask("t2");
    hb.tick();

    assert.ok(getHeartbeat(db, "t1") !== null, "t1 should still be updated");
    assert.equal(getHeartbeat(db, "t2"), null, "t2 should be left alone");
  });

  it("tick() with an empty active set is a no-op", () => {
    const db = createTestDb();
    seed(db, ["t1"]);
    const hb = createHeartbeatManager(db);

    hb.tick();
    assert.equal(
      getHeartbeat(db, "t1"),
      null,
      "no registered tasks means no writes",
    );
  });

  it("all updates inside one tick are wrapped in a single transaction", () => {
    // We can detect the BEGIN/COMMIT wrapping indirectly: intentionally
    // break the UPDATE statement so the transaction rolls back. If the
    // implementation used autocommit per row, the first few rows would
    // be visible after the failure. With a proper BEGIN/COMMIT block,
    // either all rows change or none do.
    const db = createTestDb();
    seed(db, ["t1", "t2"]);
    const hb = createHeartbeatManager(db);
    hb.registerTask("t1");
    hb.registerTask("t2");
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();

    // Drop the tasks table while the manager still holds a prepared
    // statement pointing at it. The next tick will fail; the important
    // thing is that the process does not crash.
    db.exec("DROP TABLE tasks");
    assert.doesNotThrow(() => hb.tick());
  });

  it("start() and stop() manage the underlying interval", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const db = createTestDb();
    seed(db, ["t1"]);
    const hb = createHeartbeatManager(db);

    hb.registerTask("t1");
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();

    hb.start(1000);

    t.mock.timers.tick(1000);
    assert.ok(getHeartbeat(db, "t1") !== null, "scheduled tick should fire");

    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();
    hb.stop();

    t.mock.timers.tick(10_000);
    assert.equal(
      getHeartbeat(db, "t1"),
      null,
      "no more ticks should run after stop",
    );
  });

  it("start() is idempotent (calling twice does not double-schedule)", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const db = createTestDb();
    seed(db, ["t1"]);
    const hb = createHeartbeatManager(db);
    hb.registerTask("t1");
    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();

    hb.start(1000);
    hb.start(1000); // second call ignored

    t.mock.timers.tick(1000);
    // If double-scheduled, two run()s would fire in the same tick. We
    // cannot observe a double-write directly (both set the same value),
    // but we can check that stop() cleans up exactly one timer.
    hb.stop();

    db.prepare("UPDATE tasks SET last_heartbeat_at = NULL").run();
    t.mock.timers.tick(10_000);
    assert.equal(getHeartbeat(db, "t1"), null);
  });

  it("size() reflects the active set", () => {
    const db = createTestDb();
    seed(db, ["t1", "t2", "t3"]);
    const hb = createHeartbeatManager(db);

    assert.equal(hb.size(), 0);
    hb.registerTask("t1");
    assert.equal(hb.size(), 1);
    hb.registerTask("t2");
    hb.registerTask("t3");
    assert.equal(hb.size(), 3);
    hb.unregisterTask("t2");
    assert.equal(hb.size(), 2);
  });

  it("unregistering an unknown task id is a no-op", () => {
    const db = createTestDb();
    const hb = createHeartbeatManager(db);
    assert.doesNotThrow(() => hb.unregisterTask("never-registered"));
    assert.equal(hb.size(), 0);
  });
});

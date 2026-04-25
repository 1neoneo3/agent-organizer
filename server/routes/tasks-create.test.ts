import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import express from "express";
import type { DatabaseSync } from "node:sqlite";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "ao-create-")), "agent-organizer.db");

function createCache() {
  return {
    async get() {
      return null;
    },
    async set() {},
    async del() {},
    async invalidatePattern() {},
    getStats() { return { hits: 0, misses: 0, get hitRatio() { return 0; } }; },
    resetStats() {},
    get isConnected() {
      return false;
    },
  };
}

function createWs() {
  return {
    broadcast() {},
  };
}

async function setupServer(): Promise<{
  db: DatabaseSync;
  server: Server;
  baseUrl: string;
}> {
  const { initializeDb } = await import("../db/runtime.js");
  const { createTasksRouter } = await import("./tasks.js");
  const db = initializeDb();

  const app = express();
  app.use(express.json());
  app.use(
    createTasksRouter(
      { db, ws: createWs() as never, cache: createCache() as never },
      { spawnAgent: async () => ({ pid: 0 }) as never },
    ),
  );

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  return { db, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function getCurrentMaxValidNumber(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num
       FROM tasks
       WHERE task_number LIKE '#%'
         AND LENGTH(task_number) > 1
         AND CAST(CAST(SUBSTR(task_number, 2) AS INTEGER) AS TEXT) = SUBSTR(task_number, 2)`,
    )
    .get() as { max_num: number | null } | undefined;
  return row?.max_num ?? 0;
}

describe("POST /tasks — task_number and title validation regressions", () => {
  it("rejects UUID-like title 'Task <uuid>'", async () => {
    const { db, server, baseUrl } = await setupServer();

    try {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Task 40b0c57e-1234-5678-9abc-def012345678",
        }),
      });

      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "invalid_title");
    } finally {
      await closeServer(server);
    }
  });

  it("accepts normal task titles and assigns valid task_number", async () => {
    const { db, server, baseUrl } = await setupServer();
    const maxBefore = getCurrentMaxValidNumber(db);

    try {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Fix authentication bug" }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as {
        task_number: string;
        title: string;
      };
      assert.equal(body.title, "Fix authentication bug");
      assert.match(body.task_number, /^#\d+$/);
      const num = parseInt(body.task_number.slice(1), 10);
      assert.equal(num, maxBefore + 1, "task_number must be MAX+1 of valid numbers");
    } finally {
      await closeServer(server);
    }
  });

  it("assigns correct sequential task_number ignoring hex fragments in DB", async () => {
    const { db, server, baseUrl } = await setupServer();
    const now = Date.now();

    const maxBefore = getCurrentMaxValidNumber(db);
    const seedNumber = maxBefore + 100;

    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("seed-valid-hex-test", "Valid seed", `#${seedNumber}`, now - 3000, now);
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("seed-hex1", "Hex seed 1", "#40b0c5", now - 2000, now);
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("seed-hex2", "Hex seed 2", "#082098", now - 1000, now);

    try {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New task after hex pollution" }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as { task_number: string };
      assert.equal(
        body.task_number,
        `#${seedNumber + 1}`,
        `new task_number must follow #${seedNumber}, ignoring hex fragments #40b0c5 and #082098`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("hex fragments in DB do not inflate the next task_number", async () => {
    const { db, server, baseUrl } = await setupServer();
    const now = Date.now();

    const maxBefore = getCurrentMaxValidNumber(db);

    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("corrupt-inflate-1", "Corrupt inflate 1", "#abcdef", now - 2000, now);
    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("corrupt-inflate-2", "Corrupt inflate 2", "#0face0", now - 1000, now);

    try {
      const response = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should not be inflated" }),
      });

      assert.equal(response.status, 201);
      const body = (await response.json()) as { task_number: string };
      const num = parseInt(body.task_number.slice(1), 10);

      assert.equal(
        num,
        maxBefore + 1,
        `task_number must be ${maxBefore + 1} (not inflated by corrupt entries)`,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("sequential creation maintains correct numbering through multiple tasks", async () => {
    const { db, server, baseUrl } = await setupServer();
    const now = Date.now();

    db.prepare(
      `INSERT INTO tasks (id, title, status, task_size, task_number, created_at, updated_at)
       VALUES (?, ?, 'done', 'small', ?, ?, ?)`,
    ).run("seq-hex-noise", "Hex noise", "#082098", now - 500, now);

    const maxBefore = getCurrentMaxValidNumber(db);

    try {
      const res1 = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Sequential Task A" }),
      });
      const body1 = (await res1.json()) as { task_number: string };
      assert.equal(body1.task_number, `#${maxBefore + 1}`);

      const res2 = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Sequential Task B" }),
      });
      const body2 = (await res2.json()) as { task_number: string };
      assert.equal(body2.task_number, `#${maxBefore + 2}`);

      const res3 = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Sequential Task C" }),
      });
      const body3 = (await res3.json()) as { task_number: string };
      assert.equal(body3.task_number, `#${maxBefore + 3}`);
    } finally {
      await closeServer(server);
    }
  });
});

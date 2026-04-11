import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createWsHub } from "../hub.js";

class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  listeners = new Map<string, Array<() => void>>();

  send(message: string): void {
    this.sent.push(message);
  }

  on(event: string, listener: () => void): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  ping(): void {}

  terminate(): void {
    this.readyState = 3;
  }
}

const hubs: Array<ReturnType<typeof createWsHub>> = [];

afterEach(() => {
  while (hubs.length > 0) {
    hubs.pop()!.dispose();
  }
});

describe("createWsHub", () => {
  it("broadcasts unscoped events to all clients", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    hub.addClient(ws1 as never);
    hub.addClient(ws2 as never);
    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });

    assert.equal(ws1.sent.length, 1);
    assert.equal(ws2.sent.length, 1);
  });

  it("broadcasts scoped events only to subscribed clients", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    hub.addClient(ws1 as never);
    hub.addClient(ws2 as never);
    hub.subscribeClientToTask(ws1 as never, "task-1");
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "hello" }, { taskId: "task-1" });

    assert.equal(ws1.sent.length, 1);
    assert.equal(ws2.sent.length, 0);
  });

  it("stops sending scoped events after unsubscribe", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");
    hub.unsubscribeClientFromTask(ws as never, "task-1");
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "hello" }, { taskId: "task-1" });

    assert.equal(ws.sent.length, 0);
  });

  it("sends the first cli_output event immediately and batches subsequent ones", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    // First broadcast: sent immediately (opens the batch window)
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "first" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(JSON.parse(ws.sent[0]!).payload, { task_id: "task-1", kind: "stdout", message: "first" });

    // Two more while the window is open — queued, not sent yet
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "second" }, { taskId: "task-1" });
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "third" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);

    // After the 80ms window closes, the queued payloads flush as a single broadcast
    t.mock.timers.tick(80);
    assert.equal(ws.sent.length, 2);
    const flushed = JSON.parse(ws.sent[1]!).payload as Array<{ message: string }>;
    assert.ok(Array.isArray(flushed));
    assert.equal(flushed.length, 2);
    assert.equal(flushed[0]!.message, "second");
    assert.equal(flushed[1]!.message, "third");
  });

  it("flattens array payloads when batching so clients always see a flat list", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    // First broadcast opens the window; payload is itself an array (matches
    // how process-manager sends cli_output).
    hub.broadcast(
      "cli_output",
      [
        { task_id: "task-1", kind: "stdout", message: "a" },
        { task_id: "task-1", kind: "stdout", message: "b" },
      ],
      { taskId: "task-1" },
    );
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(
      (JSON.parse(ws.sent[0]!).payload as Array<{ message: string }>).map((p) => p.message),
      ["a", "b"],
    );

    // Queue two more array payloads during the window
    hub.broadcast(
      "cli_output",
      [{ task_id: "task-1", kind: "stdout", message: "c" }],
      { taskId: "task-1" },
    );
    hub.broadcast(
      "cli_output",
      [
        { task_id: "task-1", kind: "stdout", message: "d" },
        { task_id: "task-1", kind: "stdout", message: "e" },
      ],
      { taskId: "task-1" },
    );

    t.mock.timers.tick(80);
    assert.equal(ws.sent.length, 2);
    // The flushed message must be a flat array `[c, d, e]`, NOT nested
    // `[[c], [d, e]]`.
    const flushed = JSON.parse(ws.sent[1]!).payload as Array<{ message: string }>;
    assert.ok(Array.isArray(flushed));
    assert.deepEqual(
      flushed.map((p) => p.message),
      ["c", "d", "e"],
    );
  });
});

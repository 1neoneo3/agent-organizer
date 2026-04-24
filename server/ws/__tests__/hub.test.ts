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
    const flushedMsg = JSON.parse(ws.sent[1]!);
    // Batched events must preserve the original event type ("cli_output"),
    // not leak the internal batch key like "cli_output:task-1". Clients
    // subscribe by exact type match — if this regresses, batched events
    // will be silently dropped and only the first event of each window
    // reaches the UI.
    assert.equal(flushedMsg.type, "cli_output");
    const flushed = flushedMsg.payload as Array<{ message: string }>;
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

  it("keeps delivering broadcasts after an empty-queue flush window", async (t) => {
    // Regression: previously, when the first event in a batch window had no
    // followers, the flush timer fired against an empty queue and returned
    // without deleting the batch record. Subsequent broadcasts then saw the
    // stale record, appended to its dead queue, and never fired because no
    // new timer was scheduled — so clients received only the very first
    // event per taskId for the entire task lifetime. This test guarantees
    // the fresh-batch re-open behavior after quiet windows.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    // First burst: single event, window closes empty.
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "one" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);
    t.mock.timers.tick(80); // empty-queue flush; batch record must be cleared
    assert.equal(ws.sent.length, 1);

    // Second event arrives long after the window closed. It must be sent
    // immediately because a fresh batch should have been opened.
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "two" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 2);
    assert.equal(JSON.parse(ws.sent[1]!).payload.message, "two");

    // Third event within the new window queues and flushes normally.
    hub.broadcast("cli_output", { task_id: "task-1", kind: "stdout", message: "three" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 2);
    t.mock.timers.tick(80);
    assert.equal(ws.sent.length, 3);
    const flushed = JSON.parse(ws.sent[2]!).payload as Array<{ message: string }>;
    assert.deepEqual(flushed.map((p) => p.message), ["three"]);
  });

  it("suppresses duplicate task_update payloads for the same entity", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 1);
  });

  it("delivers task_update when payload differs from last delivered", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "done" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);
    assert.equal(JSON.parse(ws.sent[1]!).payload.status, "done");
  });

  it("suppresses task_update payloads that only differ by updated_at", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress", updated_at: 100 });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress", updated_at: 200 });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 1);
  });

  it("suppresses duplicate agent_status payloads", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("agent_status", { id: "agent-1", status: "idle", current_task_id: null });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("agent_status", { id: "agent-1", status: "idle", current_task_id: null });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 1);

    hub.broadcast("agent_status", { id: "agent-1", status: "working", current_task_id: "task-1" });
    assert.equal(ws.sent.length, 2);
  });

  it("does not update dedup state when no recipients exist", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 0);
    t.mock.timers.tick(50);

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);
    assert.equal(JSON.parse(ws.sent[0]!).payload.status, "in_progress");
  });

  it("coalesces task_update by entity id within batch window", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "qa_testing" });
    hub.broadcast("task_update", { id: "task-1", status: "done" });

    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);
    assert.equal(JSON.parse(ws.sent[1]!).payload.status, "done");
  });

  it("merges queued task_update payloads for the same entity before flush", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", title: "Initial title", description: "Updated description" });
    hub.broadcast("task_update", { id: "task-1", status: "done" });

    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);
    assert.deepEqual(JSON.parse(ws.sent[1]!).payload, {
      id: "task-1",
      title: "Initial title",
      status: "done",
      description: "Updated description",
    });
  });

  it("flushes task_update as individual messages, not arrays", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    hub.broadcast("task_update", { id: "task-2", status: "done" });
    hub.broadcast("task_update", { id: "task-3", status: "inbox" });

    assert.equal(ws.sent.length, 1);

    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 3);
    for (let i = 0; i < 3; i++) {
      const msg = JSON.parse(ws.sent[i]!);
      assert.equal(msg.type, "task_update");
      assert.ok(!Array.isArray(msg.payload));
    }
    assert.equal(JSON.parse(ws.sent[0]!).payload.id, "task-1");
    assert.equal(JSON.parse(ws.sent[1]!).payload.id, "task-2");
    assert.equal(JSON.parse(ws.sent[2]!).payload.id, "task-3");
  });

  it("sends non-batched event types immediately without buffering", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_created", { id: "task-1", title: "new" });
    hub.broadcast("task_created", { id: "task-2", title: "another" });
    hub.broadcast("task_created", { id: "task-3", title: "third" });

    assert.equal(ws.sent.length, 3);
  });

  it("does not deduplicate non-DEDUP_TYPES even with identical payloads", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    const payload = { task_id: "task-1", kind: "stdout", message: "same" };

    hub.broadcast("cli_output", payload, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);

    t.mock.timers.tick(80);

    hub.broadcast("cli_output", payload, { taskId: "task-1" });
    assert.equal(ws.sent.length, 2);
  });

  it("does not deduplicate DEDUP_TYPES when payload lacks an id field", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    t.mock.timers.tick(50);

    hub.broadcast("task_update", { status: "in_progress" });
    assert.equal(ws.sent.length, 2);
  });

  it("skips clients with closed readyState", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    hub.addClient(ws1 as never);
    hub.addClient(ws2 as never);

    ws1.readyState = 3; // CLOSED
    hub.broadcast("task_created", { id: "task-1" });

    assert.equal(ws1.sent.length, 0);
    assert.equal(ws2.sent.length, 1);
  });

  it("includes type, payload, and ts in every sent message", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.broadcast("task_created", { id: "task-1", title: "test" });

    assert.equal(ws.sent.length, 1);
    const msg = JSON.parse(ws.sent[0]!);
    assert.equal(msg.type, "task_created");
    assert.deepEqual(msg.payload, { id: "task-1", title: "test" });
    assert.equal(typeof msg.ts, "number");
  });

  it("removed client does not receive subsequent broadcasts", () => {
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.broadcast("task_created", { id: "task-1" });
    assert.equal(ws.sent.length, 1);

    hub.removeClient(ws as never);
    hub.broadcast("task_created", { id: "task-2" });
    assert.equal(ws.sent.length, 1);
  });

  it("coalesces agent_status by entity id within batch window", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("agent_status", { id: "agent-1", status: "idle" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("agent_status", { id: "agent-1", status: "working" });
    hub.broadcast("agent_status", { id: "agent-1", status: "busy" });

    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);
    assert.equal(JSON.parse(ws.sent[1]!).payload.status, "busy");
  });

  it("suppresses agent_status payloads that only differ by updated_at", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("agent_status", { id: "agent-1", status: "idle", updated_at: 100 });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("agent_status", { id: "agent-1", status: "idle", updated_at: 200 });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 1);
  });

  it("coalesces different entity ids independently within same batch window", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "qa_testing" });
    hub.broadcast("task_update", { id: "task-2", status: "in_progress" });
    hub.broadcast("task_update", { id: "task-1", status: "done" });
    hub.broadcast("task_update", { id: "task-2", status: "done" });

    t.mock.timers.tick(50);

    assert.equal(ws.sent.length, 3);
    const flushed1 = JSON.parse(ws.sent[1]!).payload;
    const flushed2 = JSON.parse(ws.sent[2]!).payload;
    assert.equal(flushed1.id, "task-1");
    assert.equal(flushed1.status, "done");
    assert.equal(flushed2.id, "task-2");
    assert.equal(flushed2.status, "done");
  });

  it("maintains separate batch windows for different taskId-scoped events", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");
    hub.subscribeClientToTask(ws as never, "task-2");

    hub.broadcast("cli_output", { message: "a" }, { taskId: "task-1" });
    hub.broadcast("cli_output", { message: "b" }, { taskId: "task-2" });

    assert.equal(ws.sent.length, 2);

    hub.broadcast("cli_output", { message: "c" }, { taskId: "task-1" });
    hub.broadcast("cli_output", { message: "d" }, { taskId: "task-2" });

    assert.equal(ws.sent.length, 2);

    t.mock.timers.tick(80);

    assert.equal(ws.sent.length, 4);
    const batch1 = JSON.parse(ws.sent[2]!).payload as Array<{ message: string }>;
    const batch2 = JSON.parse(ws.sent[3]!).payload as Array<{ message: string }>;
    assert.deepEqual(batch1.map((p) => p.message), ["c"]);
    assert.deepEqual(batch2.map((p) => p.message), ["d"]);
  });

  it("drops oldest items when batch queue exceeds max size", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    hub.broadcast("cli_output", { message: "first" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);

    for (let i = 0; i < 65; i++) {
      hub.broadcast("cli_output", { message: `item-${i}` }, { taskId: "task-1" });
    }

    t.mock.timers.tick(80);
    assert.equal(ws.sent.length, 2);
    const flushed = JSON.parse(ws.sent[1]!).payload as Array<{ message: string }>;
    assert.equal(flushed.length, 60);
    assert.equal(flushed[0]!.message, "item-5");
    assert.equal(flushed[59]!.message, "item-64");
  });

  it("does not flush after dispose is called", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);
    hub.subscribeClientToTask(ws as never, "task-1");

    hub.broadcast("cli_output", { message: "first" }, { taskId: "task-1" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("cli_output", { message: "second" }, { taskId: "task-1" });

    hub.dispose();

    t.mock.timers.tick(80);
    assert.equal(ws.sent.length, 1);
  });

  it("dedup applies across all clients, not per-client", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws1 = new FakeWebSocket();
    const ws2 = new FakeWebSocket();

    hub.addClient(ws1 as never);
    hub.addClient(ws2 as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws1.sent.length, 1);
    assert.equal(ws2.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    t.mock.timers.tick(50);
    assert.equal(ws1.sent.length, 1);
    assert.equal(ws2.sent.length, 1);
  });

  it("dedup resets when payload changes, allowing subsequent identical sends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "done" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);

    hub.broadcast("task_update", { id: "task-1", status: "done" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 3);
  });

  it("coalesced flush suppresses when final state matches last delivered", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const hub = createWsHub();
    hubs.push(hub);
    const ws = new FakeWebSocket();

    hub.addClient(ws as never);

    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });
    assert.equal(ws.sent.length, 1);

    hub.broadcast("task_update", { id: "task-1", status: "qa_testing" });
    hub.broadcast("task_update", { id: "task-1", status: "in_progress" });

    t.mock.timers.tick(50);
    // Coalesced value is "in_progress" which matches lastDelivered — dedup suppresses
    assert.equal(ws.sent.length, 1);

    // A genuinely new state still goes through
    hub.broadcast("task_update", { id: "task-1", status: "done" });
    t.mock.timers.tick(50);
    assert.equal(ws.sent.length, 2);
    assert.equal(JSON.parse(ws.sent[1]!).payload.status, "done");
  });
});

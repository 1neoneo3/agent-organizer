import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDecomposeOutput } from "./decomposer.js";

describe("parseDecomposeOutput", () => {
  it("accepts controller_stage and write_scope for controller decomposition", () => {
    const result = parseDecomposeOutput(`[
      {
        "task_id": "T01",
        "title": "Implement controller API",
        "description": "Add backend API support.",
        "task_size": "medium",
        "priority": 8,
        "depends_on": [],
        "controller_stage": "implement",
        "write_scope": ["server/routes/directives.ts"]
      },
      {
        "task_id": "T02",
        "title": "Verify controller API",
        "depends_on": ["T01"],
        "controller_stage": "verify",
        "write_scope": []
      }
    ]
    ---PLAN---
    # Plan`);

    assert.equal(result.tasks[0].controller_stage, "implement");
    assert.deepStrictEqual(result.tasks[0].write_scope, ["server/routes/directives.ts"]);
    assert.equal(result.tasks[1].controller_stage, "verify");
    assert.deepStrictEqual(result.tasks[1].write_scope, []);
    assert.match(result.plan ?? "", /# Plan/);
  });

  it("defaults write_scope to [] for legacy decomposition output", () => {
    const result = parseDecomposeOutput(`[
      {
        "task_id": "T01",
        "title": "Legacy task",
        "depends_on": []
      }
    ]`);

    assert.equal(result.tasks[0].controller_stage, undefined);
    assert.deepStrictEqual(result.tasks[0].write_scope, []);
  });
});

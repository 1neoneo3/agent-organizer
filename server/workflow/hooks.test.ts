import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runWorkflowHooks } from "./hooks.js";

describe("runWorkflowHooks", () => {
  it("runs commands in the target workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-hooks-"));
    const filePath = join(dir, "hook.txt");

    const results = runWorkflowHooks([`printf "ok" > "${filePath}"`], dir);

    assert.equal(results[0]?.ok, true);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf-8"), "ok");
  });

  it("captures failures without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-hooks-"));

    const results = runWorkflowHooks(["exit 7"], dir);

    assert.equal(results[0]?.ok, false);
  });
});

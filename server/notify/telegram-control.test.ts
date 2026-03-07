import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildInteractiveResponseRequest,
  getBootstrapOffset,
  loadTelegramOffset,
  saveTelegramOffset,
} from "./telegram-control.js";

describe("buildInteractiveResponseRequest", () => {
  it("uses the pending exit_plan_mode prompt type", () => {
    assert.deepEqual(
      buildInteractiveResponseRequest(
        JSON.stringify({
          data: {
            promptType: "exit_plan_mode",
            toolUseId: "tool-1",
          },
          createdAt: 1,
        }),
        true,
      ),
      {
        ok: true,
        payload: {
          promptType: "exit_plan_mode",
          approved: true,
          freeText: undefined,
        },
      },
    );
  });

  it("rejects Telegram approval for non-exit prompts", () => {
    assert.deepEqual(
      buildInteractiveResponseRequest(
        JSON.stringify({
          data: {
            promptType: "ask_user_question",
            toolUseId: "tool-2",
          },
          createdAt: 1,
        }),
        true,
      ),
      {
        ok: false,
        detail: "unsupported_prompt_type:ask_user_question",
      },
    );
  });
});

describe("telegram offset persistence", () => {
  it("seeds the next offset from the latest update id", () => {
    assert.equal(getBootstrapOffset([{ update_id: 9 }, { update_id: 12 }]), 13);
    assert.equal(getBootstrapOffset([]), 0);
  });

  it("round-trips the offset through disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-telegram-offset-"));
    const filePath = join(dir, "offset.txt");

    try {
      assert.equal(loadTelegramOffset(filePath), 0);
      saveTelegramOffset(filePath, 42);
      assert.equal(readFileSync(filePath, "utf8"), "42\n");
      assert.equal(loadTelegramOffset(filePath), 42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

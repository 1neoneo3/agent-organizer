import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLastLines } from "../read-last-lines.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-organizer-tail-"));
  tempDirs.push(dir);
  const filePath = join(dir, "task.log");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("readLastLines", () => {
  it("returns an empty string for missing files", () => {
    assert.equal(readLastLines("/tmp/does-not-exist.log", 20), "");
  });

  it("returns the full file when it is shorter than the limit", () => {
    const filePath = createTempFile("alpha\nbeta\ngamma\n");

    assert.equal(readLastLines(filePath, 10), "alpha\nbeta\ngamma");
  });

  it("returns only the requested tail lines", () => {
    const filePath = createTempFile("l1\nl2\nl3\nl4\nl5\n");

    assert.equal(readLastLines(filePath, 2), "l4\nl5");
  });

  it("handles files without a trailing newline", () => {
    const filePath = createTempFile("one\ntwo\nthree");

    assert.equal(readLastLines(filePath, 2), "two\nthree");
  });
});

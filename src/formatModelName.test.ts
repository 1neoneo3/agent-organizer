import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatModelName } from "./formatModelName.js";

describe("formatModelName", () => {
  it("formats claude-opus-4-6", () => {
    assert.equal(formatModelName("claude-opus-4-6"), "Claude Opus 4.6");
  });

  it("formats claude-opus-4-7", () => {
    assert.equal(formatModelName("claude-opus-4-7"), "Claude Opus 4.7");
  });

  it("formats claude-sonnet-4-6", () => {
    assert.equal(formatModelName("claude-sonnet-4-6"), "Claude Sonnet 4.6");
  });

  it("formats claude-haiku-4-5", () => {
    assert.equal(formatModelName("claude-haiku-4-5"), "Claude Haiku 4.5");
  });

  it("formats gpt-5.4", () => {
    assert.equal(formatModelName("gpt-5.4"), "GPT 5.4");
  });

  it("formats gemini-2.5-pro", () => {
    assert.equal(formatModelName("gemini-2.5-pro"), "Gemini 2.5 Pro");
  });

  it("returns empty string for null", () => {
    assert.equal(formatModelName(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.equal(formatModelName(undefined), "");
  });

  it("returns raw value for unknown prefix", () => {
    assert.equal(formatModelName("custom-model-1"), "custom-model-1");
  });

  it("returns single-word value as-is", () => {
    assert.equal(formatModelName("something"), "something");
  });
});

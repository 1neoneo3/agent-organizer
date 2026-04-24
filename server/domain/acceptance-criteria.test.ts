import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countAcceptanceCriteria,
  setAcceptanceCriterionChecked,
} from "./acceptance-criteria.js";

describe("countAcceptanceCriteria", () => {
  it("counts unchecked and checked task list items", () => {
    const plan = [
      "## 受け入れ条件",
      "- [ ] criterion A",
      "- [x] criterion B",
      "- [X] criterion C (uppercase X)",
      "- plain bullet, not a checkbox",
    ].join("\n");
    assert.equal(countAcceptanceCriteria(plan), 3);
  });

  it("returns 0 for plans without checkboxes", () => {
    assert.equal(countAcceptanceCriteria("# heading\n- plain item"), 0);
  });

  it("counts items with alternative list markers and indentation", () => {
    const plan = [
      "* [ ] star marker",
      "+ [x] plus marker",
      "  - [ ] indented",
    ].join("\n");
    assert.equal(countAcceptanceCriteria(plan), 3);
  });
});

describe("setAcceptanceCriterionChecked", () => {
  const plan = [
    "## Plan",
    "- [ ] first",
    "other text",
    "- [ ] second",
    "- [x] third (already checked)",
  ].join("\n");

  it("checks an unchecked item", () => {
    const { text, total } = setAcceptanceCriterionChecked(plan, 0, true);
    assert.equal(total, 3);
    assert.ok(text);
    assert.match(text!, /^- \[x\] first$/m);
    // Other items unchanged
    assert.match(text!, /^- \[ \] second$/m);
    assert.match(text!, /^- \[x\] third/m);
  });

  it("unchecks a checked item", () => {
    const { text } = setAcceptanceCriterionChecked(plan, 2, false);
    assert.ok(text);
    assert.match(text!, /^- \[ \] third/m);
  });

  it("preserves leading whitespace and marker character", () => {
    const nested = "  + [ ] nested star plus\n  - [x] nested dash";
    const { text } = setAcceptanceCriterionChecked(nested, 1, false);
    assert.ok(text);
    assert.match(text!, /^ {2}\+ \[ \] nested star plus$/m);
    assert.match(text!, /^ {2}- \[ \] nested dash$/m);
  });

  it("returns null text when index is out of range", () => {
    const { text, total } = setAcceptanceCriterionChecked(plan, 99, true);
    assert.equal(text, null);
    assert.equal(total, 3);
  });

  it("round-trips: check then uncheck yields the original plan", () => {
    const { text: checked } = setAcceptanceCriterionChecked(plan, 1, true);
    assert.ok(checked);
    const { text: back } = setAcceptanceCriterionChecked(checked!, 1, false);
    assert.equal(back, plan);
  });
});

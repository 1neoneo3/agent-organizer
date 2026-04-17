import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRefinementSplitArtifacts } from "./output-language.js";

describe("buildRefinementSplitArtifacts", () => {
  it("builds English child task artifacts when language='en'", () => {
    const artifacts = buildRefinementSplitArtifacts({
      language: "en",
      parentTaskNumber: "#42",
      stepNumber: 2,
      totalSteps: 4,
      stepText: "Implement localized split output",
      childNumbers: "#43, #44",
      planPath: "/tmp/plan.md",
    });

    assert.equal(
      artifacts.description,
      "Step 2 of #42: Implement localized split output\n\nRefinement Plan: /tmp/plan.md",
    );
    assert.equal(
      artifacts.childPlan,
      "Parent #42 - Step 2/4: Implement localized split output",
    );
    assert.equal(
      artifacts.result,
      "Split into #43, #44\nPlan saved: /tmp/plan.md",
    );
  });

  it("builds Japanese child task artifacts by default", () => {
    const artifacts = buildRefinementSplitArtifacts({
      parentTaskNumber: "#42",
      stepNumber: 2,
      totalSteps: 4,
      stepText: "分割結果を日本語化する",
      childNumbers: "#43, #44",
      planPath: "/tmp/plan.md",
    });

    assert.equal(
      artifacts.description,
      "#42 のステップ 2: 分割結果を日本語化する\n\n調整計画: /tmp/plan.md",
    );
    assert.equal(
      artifacts.childPlan,
      "親タスク #42 - ステップ 2/4: 分割結果を日本語化する",
    );
    assert.equal(
      artifacts.result,
      "#43, #44 に分割\n計画保存先: /tmp/plan.md",
    );
  });
});

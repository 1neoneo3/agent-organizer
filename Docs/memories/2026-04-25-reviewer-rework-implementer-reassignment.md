---
category: "memory"
importance: "medium"
tags:
  - "agent-organizer"
  - "orphan-recovery"
  - "review"
  - "implementer"
---

# Rework resume must resolve an implementer, not reuse reviewer assignment

## Context

`pr_review -> in_progress` の rework 後、task の `assigned_agent_id` に reviewer 系 agent が残っていると、
orphan recovery や manual resume がその agent をそのまま implementer run に再利用してしまうことがある。
その結果、`spawnAgent()` は通常の `in_progress` 実装 run として扱い、reviewer に Explore Phase が走る。

## Fix

- reviewer / security reviewer / tester を `non-implementer` として共通判定する
- `tasks.ts` の run / resume / feedback rework / interactive resume は、assigned agent を盲信せず implementer を再解決する
- stale な reviewer assignment が見つかった場合は、idle な implementer にフォールバックする
- orphan recovery も同じ考え方で、reviewer を respawn せず replacement implementer を選べるなら差し替える

## Note

`spawnAgent()` 側で review/QA/test-generation が `assigned_agent_id` を上書きしない防御は残す。
再発防止のポイントは「resume entrypoint でも implementer 判定をかける」こと。

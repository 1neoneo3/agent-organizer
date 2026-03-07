---
title: "agent-organizer worktree でのサンドボックス制約"
category: "memory"
memory_type: "troubleshooting"
importance: "high"
tags: ["agent-organizer", "sandbox", "playwright", "git", "worktree"]
created: "2026-03-07"
---

# agent-organizer worktree でのサンドボックス制約

## 概要

Codex の `workspace-write` サンドボックス下では、agent-organizer の worktree から localhost API、Playwright の webServer 起動、Git commit がいずれも制約に当たる。

## 症状

- `ao_tasks.py` が `http://127.0.0.1:8791/api/health` へ到達できず `Operation not permitted` になる
- Playwright の `webServer` で `tsx server/index.ts` を起動すると listen が `EPERM` で失敗する
- `node --import tsx server/index.ts` で直接起動しても `0.0.0.0:8792` の listen が `EPERM` で失敗する
- worktree で `git commit` すると `.git/worktrees/<id>/index.lock` を作れず `Permission denied` になる

## 影響

- Agent Organizer へのタスク登録をこのサンドボックスから完了できない
- E2E の実行確認は `playwright test --list` や `tsc --noEmit` などの静的確認までに限定される
- 変更は作れても commit / push / PR 作成はこの環境では完了できない

## 回避策

1. 実装と静的確認は worktree 配下で実施する
2. Agent Organizer API 登録、E2E 実行、Git commit/push/PR は制約のない通常シェルで実施する
3. Playwright 側は `--list` で spec の解決と構文だけ確認しておく

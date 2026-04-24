# Agent Harness 機能構成

> "モデルでなければ、それはハーネスである" — LangChain

Agent Organizer に実装されたハーネスエンジニアリング機能の一覧。
LLM単体ではできないことを、外部の仕組みで制御・拡張する。

## アーキテクチャ概要

```
タスク投入
  │
  ├─ コンテキスト注入（ファイルパス自動抽出、類似PR検索）
  │
  ├─ スキャフォールディング（CLAUDE.md、rules、WORKFLOW.md 読み込み）
  │
  ▼
Explore フェーズ（read-only、3分タイムアウト）  ← explore_phase=true 時
  │  ├─ allowedTools: Read, Bash, Grep, Glob, Agent（Write/Edit 不可）
  │  ├─ 関連ファイル・既存パターン・実装計画・リスクを調査
  │  └─ ---EXPLORE RESULT--- として構造化出力 → DB保存
  │
  ▼ (Explore結果をプロンプトに注入)
  │
実装フェーズ（Lead Engineer エージェント）
  │  ├─ Explore結果を「## Explore Phase Result」として受け取る
  │  ├─ Sprint Contract 出力（受け入れ条件の明文化）
  │  ├─ allowedTools: 全ツール許可
  │  ├─ format_command: 自動フォーマット指示
  │  └─ ループ検出: stderr 監視、同一エラー3回で SIGTERM
  │
  ▼
pr_review ステータスに遷移
  │
  ▼
自動レビューフェーズ（Code Reviewer エージェント）
  │  ├─ allowedTools: Read, Bash, Grep, Glob のみ（Write/Edit 不可）
  │  ├─ 5項目スコアリング（Correctness, Code Quality, Error Handling, Completeness, Security）
  │  ├─ ビルド/Lintゲート: 失敗で自動 NEEDS_CHANGES
  │  └─ 最大 review_count 回まで差し戻し → 超過で inbox に戻す
  │
  ▼
done / inbox（手動レビュー）
```

## 機能一覧

### 1. ループ検出

**ファイル**: `server/spawner/process-manager.ts`

エージェントが同一エラーで無限ループに陥ることを防止する。

- stderr 出力をリアルタイム監視
- タイムスタンプ・行番号を正規化してパターンカウント
- 同一パターンが `LOOP_THRESHOLD`（デフォルト3）回に達したら SIGTERM で自動中断
- `[Loop Detection]` としてタスクログに記録

```typescript
// 正規化ルール
text
  .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, "TIMESTAMP")
  .replace(/line \d+/gi, "line N")
  .replace(/:\d+:\d+/g, ":N:N")
  .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
```

### 2. Explore → Implement 2フェーズ自動実行

**ファイル**: `server/spawner/explore-phase.ts`, `server/spawner/prompt-builder.ts`, `server/spawner/process-manager.ts`

実装前にコードベースを自動調査し、結果を実装エージェントに渡す。

#### Explore Phase（調査）
- **モジュール**: `explore-phase.ts` — `runExplorePhase()`
- **実行**: 同期実行（`spawnSync`）、Implement Phase の前に自動発火
- **タイムアウト**: 3分
- **制約**: 「DO NOT modify any files. Read-only investigation only.」
- **allowedTools**: Read, Bash, Grep, Glob, Agent（Write/Edit 不可）
- **出力フォーマット**: `---EXPLORE RESULT---` ブロックで構造化
  - Relevant Files（関連ファイル）
  - Existing Patterns（既存パターン）
  - Implementation Plan（実装計画）
  - Risks/Edge Cases（リスク）
- **結果保存**: `[EXPLORE]` プレフィックスでタスクログに保存

#### Implement Phase（実装）への注入
- Explore 結果を `## Explore Phase Result` としてプロンプト末尾に注入
- 差し戻し時の再実行では DB に保存済みの結果を再利用（重複実行防止）

#### スキップ条件
- `explore_phase` 設定が `false`（デフォルト無効、明示的に有効化が必要）
- `task_size` が `small`
- QA / レビューフェーズ
- continue（フィードバック再開）

### 3. コンテキスト注入

**ファイル**: `server/spawner/prompt-builder.ts` — `extractContextFromTask()`

タスク説明から自動的にコンテキストを抽出し、プロンプトに埋め込む。

- タスク説明中のファイルパス（`.ts`, `.py`, `.sql` 等）を正規表現で自動抽出
- `git log --merges` でそのファイルに触った直近のマージコミットを検索
- `## Auto-Injected Context` としてプロンプトの冒頭に注入

**効果**: エージェントが初期ターンでファイル探索する無駄を削減。

### 4. allowedTools 制限

**ファイル**: `server/spawner/cli-tools.ts`, `server/spawner/process-manager.ts`

フェーズに応じてエージェントが使用できるツールを制限する。

| フェーズ | 許可ツール | 制限理由 |
|---------|-----------|---------|
| 実装 | Read, Write, Edit, Bash, Grep, Glob, Agent | 全操作が必要 |
| Explore | Read, Bash, Grep, Glob, Agent | ファイル変更を禁止 |
| レビュー/QA | Read, Bash, Grep, Glob | ファイル変更・サブエージェント起動を禁止 |

Claude Code の `--allowedTools` オプションで強制。プロンプトの「お願い」ではなく、ツールレベルで制約。

### 5. 自動フォーマット（format_command）

**ファイル**: `server/workflow/loader.ts`, `server/spawner/prompt-builder.ts`

プロジェクトの `WORKFLOW.md` に定義されたフォーマットコマンドをプロンプトに注入。

```markdown
# WORKFLOW.md
---
format_command: yarn fix:all --quiet
---
```

エージェントがファイル編集後にフォーマッターを実行するよう指示される。
プロジェクトごとに異なるフォーマッター（Biome, Prettier, Ruff 等）に対応。

### 6. 自動レビュー

**ファイル**: `server/spawner/auto-reviewer.ts`

タスクが `pr_review` ステータスに遷移すると自動で発火。

- `code_reviewer` ロールのアイドルエージェントを検索して起動
- 5項目 × 5点でスコアリング
  - 4-5 全項目 → `[REVIEW:PASS]`
  - 1-2 いずれか → `[REVIEW:NEEDS_CHANGES]`
- ビルド/Lintゲート: `npm run lint`, `npm run build`, `tsc --noEmit` のいずれか失敗で自動 NEEDS_CHANGES
- `review_count` が上限（デフォルト2）に達したら inbox に戻して手動レビュー

### 7. 受け入れ条件（Acceptance Criteria）チェック

**ファイル**: `server/spawner/prompt-builder.ts` — `buildQaPrompt()`

QA エージェントがタスクの受け入れ条件を自動検証。

1. タスク説明（または Sprint Contract）から 3-7 個のテスト可能な受け入れ条件を抽出
2. ビルド/Lintゲートを先に実行（失敗で即 `[QA:FAIL]`）
3. 各条件を実際にコードを実行して検証（読むだけではなく実行する）
4. 全条件 PASS → `[QA:PASS]`、いずれか FAIL → `[QA:FAIL]`

### 8. Sprint Contract

**ファイル**: `server/spawner/prompt-builder.ts` — `buildTaskPrompt()`

実装エージェントにコード変更前に「契約」を出力させる仕組み。

```
---SPRINT CONTRACT---
**Deliverables:**
1. [具体的なファイル/機能]

**Acceptance Criteria:**
- [ ] [テスト可能な条件]

**Out of Scope:**
- [やらないこと]
---END CONTRACT---
```

この契約は QA エージェントが検証時に参照する。

## 設定

### AO Settings（API経由で変更可能）

| 設定 | デフォルト | 説明 |
|------|----------|------|
| `auto_review` | `true` | 自動レビューの有効/無効 |
| `review_mode` | `pr_only` | レビュー方式（pr_only / none） |
| `review_count` | `2` | 自動レビューの最大回数 |
| `explore_phase` | `false` | `true`: Implement 前に Explore Phase を自動実行 |
| `github_write_mode` | `enabled` | GitHub push/PR作成の許可 |

### WORKFLOW.md（プロジェクトごと）

```markdown
---
workspace_mode: git-worktree
format_command: yarn fix:all --quiet
before_run: ["npm install"]
after_run: ["npm run lint"]
---
```

### Hook dependency cache

- `before_run` / `after_run` の hook は `data/hook-cache/` に成功時の fingerprint を保存する
- 同じ command と同じ入力 fingerprint なら hook は `SKIPPED (cached)` になる
- fingerprint には command 文字列も含まれるため、オプション変更だけでも invalidate される
- 現在の主な対象:
  - install 系: `package.json` + lockfile / requirements 系
  - codegen 系: `codegen.*`, `graphql.config.*`, `schema.graphql`, `openapi.*` などの代表的な入力
- task log には `invalidate on ... changes` が出るので、どのファイル変更で再実行されるか追跡できる

## 今後の拡張候補

| 機能 | 概要 | 参考 |
|------|------|------|
| 分単位タイムアウト | 難易度別 30/90/120分 | 記事: エクスプラザ |
| 週次品質スキャン | 12項目チェック + autoFixable 自動PR | 記事: エントロピー管理 |
| Playwright 統合 | 視覚的な E2E テスト検証 | — |
| FIFO コスト追跡 | エージェント実行のトークン/時間コスト集計 | — |

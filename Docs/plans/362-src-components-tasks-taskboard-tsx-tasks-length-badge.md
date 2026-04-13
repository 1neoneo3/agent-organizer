# `src/components/tasks/TaskBoard.tsx` の現在の列ヘッダ実装を基準に、`tasks.length` の単純表示を badge 表現へ置き換える前提を整理する


## 要求 (Business Requirements)

- kanban の各列で、いま何件タスクがあるかを列名の横でひと目で確認したい
- 件数表示は見出しの一部として自然に見え、カード一覧を見なくても列の混み具合が分かってほしい
- タスクを作成・移動・完了・削除した直後に、件数表示もすぐ更新されてほしい
- タスクが 0 件の列でも、空であることがすぐ分かってほしい
- 既存の列順、横スクロール、カード操作、詳細表示の使い方は変わらないでほしい
- 将来、必要なら優先度の偏りも補足情報として見られる余地を残したい

## 技術要件 (Technical Requirements)

- 現在の列ヘッダは `src/components/tasks/TaskBoard.tsx` 内の `TaskColumn` で、ドット、`town`、`tasks.length` を横並びで描画している
- `TaskBoard` は `tasks` から `groupTasksByStatusStable` を使って `tasksByStatus` を作っているため、badge 用の件数もこの派生データから計算する
- 集計ロジックは UI に直書きせず、`src/components/tasks/task-columns.ts` の純粋関数として追加する前提が妥当
- `TASK_BOARD_COLUMNS` の列定義と `groupTasksByStatusStable` の安定参照最適化は維持する
- 現在の `TaskColumnProps` では `label` は渡されているが列ヘッダ表示には使っておらず、表示基準は `town`
- 見た目は `TaskBoard.tsx` の既存 inline style パターンに合わせ、専用コンポーネント追加は不要
- API / DB / WebSocket の変更は不要
- 優先度内訳を扱うなら `Task.priority` 数値だけを使い、固定バケットの閾値を明文化する必要がある
- 既存テスト棚卸し:
- `src/components/tasks/task-columns.test.ts` は列定義・グルーピング・並び順・参照再利用を検証している
- `src/components/tasks/agent-view.test.ts` は周辺の純粋ロジック検証で、今回の直接変更対象ではない
- `e2e/task-flow.spec.ts` はボード表示を含む広めの統合フローを持つ
- `e2e/task-crud.spec.ts` は Inbox 表示確認を持つが、`/INBOX \\(1\\)/` という旧ヘッダ前提が残っている
- 既存テスト現状:
- `node --import tsx --test src/components/tasks/task-columns.test.ts src/components/tasks/agent-view.test.ts` は green
- `pnpm check` は green
- `pnpm test:e2e e2e/task-crud.spec.ts --grep "create a task via UI and verify it appears in Inbox"` は red
- E2E の red 要因は badge 未実装ではなく、`server/index.ts` が `dist/index.html` を返す前提なのに worktree に `dist/` が無く、`page.goto('/')` が `Not Found` になること
- CI 状況:
- `.github/workflows/` はこの worktree では見当たらず、現状はローカル実行前提

## 受け入れ条件 (Acceptance Criteria)

- [ ] 各 kanban 列ヘッダで、列名の横に総件数 badge を表示する前提が整理されている
- [ ] 件数の算出元が `tasksByStatus` ベースであることが明確になっている
- [ ] タスクの追加・移動・完了・削除の各操作直後に、badge 件数がリレンダーで即座に追従すべきことが明記されている
- [ ] 0 件列の扱いを含め、badge 表示ルールが定義されている
- [ ] 列順、横スクロール、カード操作、詳細モーダルなど既存挙動を変えないことが明記されている
- [ ] badge は既存 inline style 方針で実装し、新規共通コンポーネントを追加しないことが明記されている
- [ ] API・DB・WebSocket に変更を入れない前提が受け入れ条件として明記されている
- [ ] 優先度内訳を入れる場合の扱いが「今回やる / 今回やらない」を含めて整理されている
- [ ] 単体テストの追加先と検証観点が特定されている
- [ ] E2E の既知ブロッカーと、この変更と切り分ける方針が明記されている
- [ ] アクティブタスクとの依存関係とファイル競合が整理されている

## 期待値 (Expected Outcomes)

- 実装担当が `TaskBoard.tsx` と `task-columns.ts` のどこを触ればよいか迷わない
- badge 化の影響範囲が UI 変更と集計ヘルパー追加に閉じることが分かる
- 回帰テストの追加先が明確になり、広い E2E spec に不要な責務を混ぜずに済む
- E2E の baseline 問題を badge 変更の不具合と誤認しなくなる

## 変更対象ファイル (Files to Modify)

- `src/components/tasks/TaskBoard.tsx` — 列ヘッダの `tasks.length` 表示を badge UI に置き換える
- `src/components/tasks/task-columns.ts` — 列ごとの件数サマリを返す純粋関数を追加する
- `src/components/tasks/task-columns.test.ts` — 件数サマリと 0 件・複数列・優先度混在のテストを追加する
- `e2e/task-board-columns.spec.ts` — (新規作成) badge 件数だけを確認する軽い回帰テストを追加する
- `e2e/task-crud.spec.ts` — 旧ヘッダ文字列前提が残る場合のみ調整する
- `server/index.ts` — (今回の badge 実装とは別件) E2E baseline 修正時の候補

## 実装計画 (Implementation Plan)

1. `src/components/tasks/TaskBoard.tsx` の現行ヘッダを基準に、ドット・列名・件数の横並び構造を崩さず badge に置き換える前提を確定する
2. `src/components/tasks/task-columns.ts` に、`TaskColumns` から列ごとの `total` を返す純粋関数を追加する方針を固める
3. 優先度内訳を今回スコープに入れるか判断し、入れる場合だけ固定バケットと表示先を決める
4. `src/components/tasks/task-columns.test.ts` に追加すべきケースを、総件数、0 件、複数列、優先度混在で定義する
5. `e2e/task-board-columns.spec.ts` を新設し、件数 badge だけを確認する専用 spec に分離する
6. `e2e/task-crud.spec.ts` の `INBOX (1)` 前提は、badge 実装後に必要最小限で更新する方針にする
7. E2E の `Not Found` 問題は別ブロッカーとして扱い、badge 実装の完了条件とは切り分けて進める

## リスク・注意点 (Risks & Considerations)

- 現在すでに `tasks.length` の素表示があるため、主作業は新機能追加ではなく見た目変更と集計責務の整理になる
- 列幅は `minWidth: 240px`、`maxWidth: 340px` なので、badge の padding や長い列名との干渉に注意が必要
- `label` は未使用で `town` が表示基準なので、テストや仕様書でどちらを列名として扱うかを揃える必要がある
- 優先度内訳は仕様が未確定で、入れるとこのタスクのスコープが膨らみやすい
- E2E の現在の red は UI 文言差分ではなく配信基盤の問題なので、badge 変更の回帰とは別に扱うべき
- `groupTasksByStatusStable` の参照再利用を壊すと不要な再レンダにつながるため、集計追加でも不必要な state は増やさない方がよい

## 依存関係・コンフリクト (Dependencies & Conflicts)

- No blocking dependency: この refinement 自体は単独で完了できる
- Conflicts with #363: `src/components/tasks/task-columns.ts` に同じ件数集計ヘルパーを追加する実装タスク
- Conflicts with #364: `src/components/tasks/TaskBoard.tsx` の列ヘッダ表示を変更する実装タスク
- Conflicts with #365: 優先度内訳を `title` / `aria-label` に載せる判断と実装で同じヘッダ領域を触る
- Conflicts with #366: `src/components/tasks/task-columns.test.ts` の追加テストと同一ファイル
- Conflicts with #367: `e2e/task-board-columns.spec.ts` を新設する実装タスク
- Conflicts with #368: `e2e/task-crud.spec.ts` の旧前提調整と同一ファイル
- Related to #369: 検証コマンドの順序と完了条件の整理対象
- Related to #370: Playwright baseline の `Not Found` 問題が残る場合は先に切り分けが必要
- No conflicts: #371、#326、#325 は対象ファイル・目的が別
- Potential conflict with #357: テスト基盤や CI 整備で `package.json` や Playwright 周辺が動く可能性がある
- Potential conflict with #360: E2E まわりの見直しタイミングが重なる可能性がある

## 更新されたタスク説明 (Updated Description)

`src/components/tasks/TaskBoard.tsx` の現在の列ヘッダは、色ドット、`town`、`tasks.length` の順で横並び表示している。この単純な件数表示を badge 表現へ置き換えるため、件数の算出は既存の `tasksByStatus` から派生させ、UI 直書きではなく `src/components/tasks/task-columns.ts` の純粋関数へ切り出す前提で整理する。影響範囲はフロントエンド内に閉じ、API / DB 変更は不要。回帰検知は `task-columns.test.ts` の単体テスト追加と、件数 badge 専用の軽い E2E 追加で担保する。なお現時点の Playwright は `server/index.ts` の `dist/index.html` 前提と worktree の `dist/` 不在により `/` が `Not Found` で失敗しているため、badge 変更の評価とは切り分けて扱う。

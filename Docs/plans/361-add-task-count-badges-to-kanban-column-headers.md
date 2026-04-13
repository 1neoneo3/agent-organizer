# Add task count badges to kanban column headers


## 要求 (Business Requirements)

- kanban の各列で、いま何件タスクがあるかを列名の横でひと目で確認したい
- 件数表示は見出しの一部として自然に見え、カード一覧より先に目に入ってほしい
- タスクを作成・移動・完了したあと、件数がすぐ最新状態に変わってほしい
- タスクが 0 件の列でも、空であることが分かるようにしてほしい
- 必要であれば、件数に加えて「優先度の高いタスクがどれだけあるか」も素早く把握したい
- 既存の列の並び順、スクロール、カード操作、詳細表示の動きは変わらないでほしい

## 技術要件 (Technical Requirements)

- 既存の `TaskBoard` は `tasks` を受け取り、`groupTasksByStatusStable` で列ごとにまとめているため、この結果から列ヘッダ用の件数を派生させる
- 件数表示の元データはすでにフロントエンドにあるため、API / DB / WebSocket の変更は不要
- 集計ロジックは UI に直書きせず、`src/components/tasks/task-columns.ts` の純粋関数として切り出すと単体テストしやすい
- 優先度内訳を入れる場合は既存の `Task.priority` 数値だけを使い、バックエンド側の保存形式は変えない
- 見た目は `TaskBoard.tsx` の既存 inline style パターンに合わせ、専用コンポーネント新設は不要
- 既存テスト棚卸し:
  - `src/components/tasks/task-columns.test.ts` 列定義・並び替えの単体テスト
  - `src/components/tasks/agent-view.test.ts` 関連補助ロジックの単体テスト
  - `e2e/task-flow.spec.ts` ボード表示を含む統合フロー
  - `e2e/task-crud.spec.ts` Inbox 表示確認
- 既存テスト現状:
  - `node --import tsx --test src/components/tasks/task-columns.test.ts src/components/tasks/agent-view.test.ts` は green
  - `pnpm check` は green
  - Playwright は現環境で `/` が `Not Found` を返し `text=TOWN MAP` 待ちで失敗しており、件数バッジ変更とは別のベースライン問題がある
- CI 状況:
  - `.github/workflows/` が見当たらず、現状はローカル実行前提
  - このタスク自体に CI 追加は必須ではないが、将来的には E2E を含む workflow 追加余地がある

## 受け入れ条件 (Acceptance Criteria)

- [ ] すべての kanban 列ヘッダで、列名の横に総件数バッジが表示される
- [ ] バッジの数値は、その列に表示されているカード数と常に一致する
- [ ] タスクの追加・移動・完了・削除の各操作直後に、badge 件数が再描画で即座に最新状態へ反映される
- [ ] 0 件の列でも `0` が表示され、空列であることが分かる
- [ ] 列の順序、横スクロール、カード選択、詳細モーダル、ログ表示の既存挙動が変わらない
- [ ] badge の実装は `TaskBoard.tsx` の既存 inline style 方針に従い、新規の共通コンポーネントを追加しない
- [ ] 件数表示対応のために API・DB・WebSocket のスキーマや契約を変更しない
- [ ] 単体テストで件数集計ロジックを検証できる
- [ ] 優先度内訳を入れる場合は、閾値と表示形式が固定され、対応テストが追加される
- [ ] E2E を更新する場合は、既存の広いフロー spec に混ぜず、件数表示だけを確認する回帰テストとして分離される

## 期待値 (Expected Outcomes)

- ユーザーがボードを開いた瞬間に、各工程の詰まり具合を把握できる
- 列ごとの負荷確認がカードを数えなくても済む
- 実装はフロントエンドだけで閉じ、既存 API やデータ構造に影響しない
- 件数表示の変更に対して単体テストで安全網が増える
- E2E 環境が直れば、件数表示の回帰も自動検知しやすくなる

## 変更対象ファイル (Files to Modify)

- `src/components/tasks/TaskBoard.tsx` — 列ヘッダの数値表示を badge UI に置き換え、必要なら優先度内訳の見せ方を追加
- `src/components/tasks/task-columns.ts` — 列ごとの総件数と任意の優先度内訳を返す集計ヘルパーを追加
- `src/components/tasks/task-columns.test.ts` — 集計ヘルパーと 0 件/混在優先度ケースのテストを追加
- `e2e/task-board-columns.spec.ts` — (新規作成) 列ヘッダ badge の回帰確認専用 E2E を追加
- `e2e/task-crud.spec.ts` — 既存の `INBOX (1)` 前提が残る場合のみ、実 UI に合わせて更新

## 実装計画 (Implementation Plan)

1. `src/components/tasks/TaskBoard.tsx` の現在の列ヘッダ実装を基準に、`tasks.length` の単純表示を badge 表現へ置き換える前提を整理する
2. `src/components/tasks/task-columns.ts` に、各列の `total` を返す純粋関数を追加し、優先度内訳が必要なら同じ場所で `high / medium / low` などの固定バケットに変換する
3. `src/components/tasks/TaskBoard.tsx` で `tasksByStatus` から列サマリを組み立て、見出しの `town` の横に badge を表示する
4. 優先度内訳を入れる場合は `TaskBoard.tsx` で常時表示ではなく、補助テキストか `title` / `aria-label` のどちらに載せるかを決めて実装する
5. `src/components/tasks/task-columns.test.ts` に、総件数、0 件、複数列、優先度混在時の期待値テストを追加する
6. `e2e/task-board-columns.spec.ts` を新設し、Inbox / Done など複数列の badge 数値が正しいことだけを確認する軽い回帰テストを用意する
7. 既存の `e2e/task-crud.spec.ts` に古い文字列前提が残る場合のみ調整し、他のフロー系 spec との責務重複を避ける
8. 実装後は `node --import tsx --test src/components/tasks/task-columns.test.ts`, `pnpm check`, `pnpm test:e2e e2e/task-board-columns.spec.ts` の順で再実行する
9. Playwright の `Not Found` 問題が先に残る場合は、件数バッジ変更と切り分けて E2E ベースライン修正を先に行う

## リスク・注意点 (Risks & Considerations)

- 現在の `TaskBoard.tsx` にはすでに件数の素表示があるため、実質的には「データ追加」より「見た目変更 + テスト整備」が主作業になる
- 優先度内訳は現状 UI に基準がなく、しきい値を決めずに実装すると恣意的になりやすい
- `priority` は 0-10 の数値なので、内訳を出すなら `high >= 8` などのルール明文化が必要
- `e2e/task-crud.spec.ts` の `INBOX (1)` 前提は現 UI とずれている可能性があり、今回の変更でさらに壊れやすい
- Playwright は現時点でアプリシェル自体が開けず baseline red なので、E2E を完了条件に含めるなら先に環境修正が必要
- 回帰リスクは、列ヘッダのレイアウト崩れ、狭い画面での折り返し、長い列名と badge の干渉
- 列順や `groupTasksByStatusStable` の安定参照最適化は維持すべきで、集計追加で不要な再レンダを増やさない方針が望ましい

## 依存関係・コンフリクト (Dependencies & Conflicts)

- No conflicts: #326 はデータ検証タスクで、対象ファイル・機能が別
- No conflicts: #325 は別機能・別領域の修正で、kanban UI とは独立
- Conflicts with #357: テスト・CI 整備タスクなので `package.json`、Playwright、将来の workflow 追加と競合する可能性がある
- Conflicts with #360: `e2e/task-flow.spec.ts` を直接編集すると、同じ spec ファイル上で衝突する可能性がある
- No blocking dependency: 実装自体は単独で進められる
- 回避策: 回帰テストは `e2e/task-board-columns.spec.ts` に分離し、#357 / #360 と spec ファイル競合を避ける

## 更新されたタスク説明 (Updated Description)

kanban ボードの各列ヘッダに、現在その列に存在するタスク総数を badge として表示する。件数は既存のタスク一覧データからフロントエンドで集計し、タスク作成・移動・完了・削除後に最新値へ追従させる。既存の列順、カード操作、詳細表示は変えない。必要なら既存 `priority` 数値を使った簡易内訳も追加できるように設計するが、その場合は表示ルールを明文化してテストで固定する。回帰テストは既存の大きな task flow spec に混ぜず、列ヘッダ件数専用の軽い spec に分離して管理する。

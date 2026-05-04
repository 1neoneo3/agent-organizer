# Repository Preflight Recovery

AO の git-worktree mode は task の `project_path` と `repository_url` が同じ repository を指すことを起動前に検証する。
`project_path` が git toplevel でない、`origin` がない、または remote が `repository_url` と一致しない場合、task は実行されず `human_review` へ移る。

## Operator Checks

```bash
git -C <project_path> rev-parse --show-toplevel
git -C <project_path> remote get-url origin
```

`rev-parse --show-toplevel` の結果は `project_path` と同じディレクトリである必要がある。

## Repair SQL

誤った `repository_url` は task を再実行する前に修正する。

```sql
UPDATE tasks
SET repository_url = 'https://github.com/<owner>/<repo>'
WHERE id = '<task-id>';
```

`project_path` が親ディレクトリを指している場合は、対象 repository の git toplevel に更新する。

```sql
UPDATE tasks
SET project_path = '/home/mk/workspace/<repo>',
    repository_url = 'https://github.com/<owner>/<repo>'
WHERE id = '<task-id>';
```

残った worktree を手動削除する場合は、対象 task の path だけを確認してから削除する。

```bash
git -C /home/mk/workspace/<repo> worktree remove --force /home/mk/workspace/<repo>/.ao-worktrees/<task-id>
git -C /home/mk/workspace/<repo> worktree prune
```

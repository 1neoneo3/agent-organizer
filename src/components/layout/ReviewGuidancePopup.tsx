import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskSummary } from "../../types/index.js";
import { collectReviewTransitions, type ReviewTransition } from "../../hooks/state-updates.js";

type ReviewTask = Pick<
  TaskSummary,
  | "id"
  | "title"
  | "status"
  | "updated_at"
  | "pr_url"
  | "review_branch"
  | "review_commit_sha"
  | "review_sync_status"
  | "review_sync_error"
>;

interface ReviewGuidancePopupProps {
  tasks: ReviewTask[];
  onNavigateToTask: (taskId: string) => void;
}

const REVIEW_GUIDE: Record<"pr_review", { title: string; checks: string[]; actions: string[] }> = {
  pr_review: {
    title: "PR Review",
    checks: [
      "PRの差分が要求スコープ内か",
      "テスト計画と実行結果が妥当か",
      "セキュリティ/運用リスクが残っていないか",
    ],
    actions: [
      "Task Detail から PR URL と要約を確認",
      "差分レビュー後に承認または修正依頼",
      "レビュー完了なら DONE に進める",
    ],
  },
};

interface QueueItem extends ReviewTransition {
  key: string;
  pr_url: string | null;
  review_branch: string | null;
  review_commit_sha: string | null;
  review_sync_status: string | null;
  review_sync_error: string | null;
}

function toReviewTask(task: ReviewTask): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    assigned_agent_id: null,
    project_path: null,
    status: task.status,
    priority: 0,
    task_size: "small",
    task_number: null,
    depends_on: null,
    pr_url: task.pr_url ?? null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    review_branch: task.review_branch ?? null,
    review_commit_sha: task.review_commit_sha ?? null,
    review_sync_status: task.review_sync_status ?? null,
    review_sync_error: task.review_sync_error ?? null,
    repository_url: null,
    settings_overrides: null,
    started_at: null,
    completed_at: null,
    last_heartbeat_at: null,
    auto_respawn_count: 0,
    parent_task_number: null,
    child_task_numbers: null,
    has_refinement_plan: false,
    created_at: 0,
    updated_at: task.updated_at,
  };
}

export function ReviewGuidancePopup({ tasks, onNavigateToTask }: ReviewGuidancePopupProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [seenKeys, setSeenKeys] = useState<Set<string>>(new Set());
  const hasHydrated = useRef(false);
  const previousTasksRef = useRef<TaskSummary[]>([]);
  const normalizedTasks = useMemo(() => tasks.map(toReviewTask), [tasks]);

  useEffect(() => {
    if (!hasHydrated.current) {
      previousTasksRef.current = normalizedTasks;
      hasHydrated.current = true;
      return;
    }

    const transitions = collectReviewTransitions(previousTasksRef.current, normalizedTasks).map((transition) => {
      const currentTask = normalizedTasks.find((task) => task.id === transition.taskId);
      return {
        ...transition,
        key: `${transition.taskId}:${transition.to}:${currentTask?.updated_at ?? 0}`,
        pr_url: currentTask?.pr_url ?? null,
        review_branch: currentTask?.review_branch ?? null,
        review_commit_sha: currentTask?.review_commit_sha ?? null,
        review_sync_status: currentTask?.review_sync_status ?? null,
        review_sync_error: currentTask?.review_sync_error ?? null,
      };
    });
    previousTasksRef.current = normalizedTasks;

    if (transitions.length === 0) {
      return;
    }

    setSeenKeys((prevSeen) => {
      const nextSeen = new Set(prevSeen);
      const fresh = transitions.filter((transition) => !nextSeen.has(transition.key));
      for (const transition of fresh) {
        nextSeen.add(transition.key);
      }
      if (fresh.length > 0) {
        setQueue((prevQueue) => [...prevQueue, ...fresh]);
      }
      return nextSeen;
    });
  }, [normalizedTasks]);

  const current = queue[0];
  if (!current) {
    return null;
  }

  const currentTask = normalizedTasks.find((task) => task.id === current.taskId);
  const guide = REVIEW_GUIDE[current.to];
  const reviewTarget = {
    branch: currentTask?.review_branch ?? null,
    commitSha: currentTask?.review_commit_sha ?? null,
    prUrl: currentTask?.pr_url ?? null,
    syncStatus: currentTask?.review_sync_status ?? null,
    syncError: currentTask?.review_sync_error ?? null,
  };

  const closeCurrent = () => {
    setQueue((prev) => prev.slice(1));
  };

  const openTask = () => {
    onNavigateToTask(current.taskId);
    closeCurrent();
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="review-guidance-popup"
    >
      <div className="eb-window w-full max-w-xl">
        <div className="eb-window-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <span>Review Checklist</span>
          <span className="eb-label" style={{ fontSize: "8px", color: "var(--eb-highlight)" }}>{guide.title}</span>
        </div>
        <div className="eb-window-body" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <div className="eb-label" style={{ marginBottom: "4px", color: "var(--eb-highlight)" }}>Task</div>
            <div className="eb-body" style={{ fontSize: "11px" }}>{current.title}</div>
          </div>
          <div>
            <div className="eb-label" style={{ marginBottom: "4px", color: "var(--eb-highlight)" }}>確認観点</div>
            <ul style={{ margin: 0, paddingLeft: "16px", display: "grid", gap: "4px", fontSize: "11px" }}>
              {guide.checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="eb-label" style={{ marginBottom: "4px", color: "var(--eb-highlight)" }}>期待アクション</div>
            <ul style={{ margin: 0, paddingLeft: "16px", display: "grid", gap: "4px", fontSize: "11px" }}>
              {guide.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          </div>
          {(reviewTarget.branch || reviewTarget.commitSha || reviewTarget.prUrl || reviewTarget.syncStatus || reviewTarget.syncError) && (
            <div>
              <div className="eb-label" style={{ marginBottom: "4px", color: "var(--eb-highlight)" }}>Review Target</div>
              <div style={{ display: "grid", gap: "4px", fontSize: "11px" }}>
                {reviewTarget.branch && <div>Branch: <span style={{ fontFamily: "var(--font-mono)" }}>{reviewTarget.branch}</span></div>}
                {reviewTarget.commitSha && <div>Commit SHA: <span style={{ fontFamily: "var(--font-mono)" }}>{reviewTarget.commitSha}</span></div>}
                {reviewTarget.prUrl && <div>PR URL: <span style={{ overflowWrap: "anywhere", wordBreak: "break-all" }}>{reviewTarget.prUrl}</span></div>}
                {reviewTarget.syncStatus && <div>Sync status: {reviewTarget.syncStatus}</div>}
                {reviewTarget.syncError && <div>Sync error: {reviewTarget.syncError}</div>}
              </div>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
            <button className="eb-btn" type="button" data-testid="review-guidance-close" onClick={closeCurrent}>
              LATER
            </button>
            <button className="eb-btn eb-btn--primary" type="button" data-testid="review-guidance-open-task" onClick={openTask}>
              OPEN TASK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

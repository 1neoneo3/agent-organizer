import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../types/index.js";
import { collectReviewTransitions, type ReviewTransition } from "../../hooks/state-updates.js";

type ReviewTask = Pick<Task, "id" | "title" | "status" | "updated_at">;

interface ReviewGuidancePopupProps {
  tasks: ReviewTask[];
  onNavigateToTask: (taskId: string) => void;
}

const REVIEW_GUIDE: Record<"self_review" | "pr_review", { title: string; checks: string[]; actions: string[] }> = {
  self_review: {
    title: "Self Review",
    checks: [
      "実装が依頼内容を満たしているか",
      "明らかなバグや回帰がないか",
      "テスト/型チェック結果に失敗がないか",
    ],
    actions: [
      "Task Detail で変更内容と結果を確認",
      "必要なら LOG から根拠を確認",
      "問題があれば MSG で修正依頼を返す",
    ],
  },
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
}

function toReviewTask(task: ReviewTask): Task {
  return {
    id: task.id,
    title: task.title,
    description: null,
    assigned_agent_id: null,
    project_path: null,
    status: task.status,
    priority: 0,
    task_size: "small",
    task_number: null,
    depends_on: null,
    result: null,
    refinement_plan: null,
    pr_url: null,
    review_count: 0,
    directive_id: null,
    external_source: null,
    external_id: null,
    repository_url: null,
    started_at: null,
    completed_at: null,
    created_at: 0,
    updated_at: task.updated_at,
  };
}

export function ReviewGuidancePopup({ tasks, onNavigateToTask }: ReviewGuidancePopupProps) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [seenKeys, setSeenKeys] = useState<Set<string>>(new Set());
  const hasHydrated = useRef(false);
  const previousTasksRef = useRef<Task[]>([]);
  const normalizedTasks = useMemo(() => tasks.map(toReviewTask), [tasks]);

  useEffect(() => {
    if (!hasHydrated.current) {
      previousTasksRef.current = normalizedTasks;
      hasHydrated.current = true;
      return;
    }

    const transitions = collectReviewTransitions(previousTasksRef.current, normalizedTasks).map((transition) => ({
      ...transition,
      key: `${transition.taskId}:${transition.to}:${normalizedTasks.find((task) => task.id === transition.taskId)?.updated_at ?? 0}`,
    }));
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

  const guide = REVIEW_GUIDE[current.to];

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

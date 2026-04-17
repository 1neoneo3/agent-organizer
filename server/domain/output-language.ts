import type { OutputLanguage } from "../config/runtime.js";

interface RefinementSplitArtifactsInput {
  language?: OutputLanguage;
  parentTaskNumber: string | null;
  stepNumber: number;
  totalSteps: number;
  stepText: string;
  childNumbers: string;
  planPath?: string | null;
}

interface RefinementSplitArtifacts {
  description: string;
  childPlan: string;
  result: string;
}

const DEFAULT_LANGUAGE: OutputLanguage = "ja";

export function buildRefinementSplitArtifacts({
  language = DEFAULT_LANGUAGE,
  parentTaskNumber,
  stepNumber,
  totalSteps,
  stepText,
  childNumbers,
  planPath,
}: RefinementSplitArtifactsInput): RefinementSplitArtifacts {
  const parentLabel = parentTaskNumber ?? "parent";
  const normalizedPlanPath = planPath?.trim() ? planPath : null;

  if (language === "en") {
    return {
      description: `Step ${stepNumber} of ${parentLabel}: ${stepText}${normalizedPlanPath ? `\n\nRefinement Plan: ${normalizedPlanPath}` : ""}`,
      childPlan: `Parent ${parentLabel} - Step ${stepNumber}/${totalSteps}: ${stepText}`,
      result: `Split into ${childNumbers}${normalizedPlanPath ? `\nPlan saved: ${normalizedPlanPath}` : ""}`,
    };
  }

  return {
    description: `${parentLabel} のステップ ${stepNumber}: ${stepText}${normalizedPlanPath ? `\n\n調整計画: ${normalizedPlanPath}` : ""}`,
    childPlan: `親タスク ${parentLabel} - ステップ ${stepNumber}/${totalSteps}: ${stepText}`,
    result: `${childNumbers} に分割${normalizedPlanPath ? `\n計画保存先: ${normalizedPlanPath}` : ""}`,
  };
}

export const FEEDBACK_MAX_LENGTH = 10_000;
export const FEEDBACK_REQUIRED_MESSAGE = "Feedback cannot be empty.";
export const FEEDBACK_TOO_LONG_MESSAGE = `Feedback must be ${FEEDBACK_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;

export interface FeedbackValidationResult {
  content: string;
  error: string | null;
}

export function validateFeedbackContent(raw: string): FeedbackValidationResult {
  const content = raw.trim();

  if (!content) {
    return { content, error: FEEDBACK_REQUIRED_MESSAGE };
  }

  if (content.length > FEEDBACK_MAX_LENGTH) {
    return { content, error: FEEDBACK_TOO_LONG_MESSAGE };
  }

  return { content, error: null };
}

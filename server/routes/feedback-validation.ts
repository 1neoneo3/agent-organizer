export const FEEDBACK_MAX_LENGTH = 10_000;
export const FEEDBACK_REQUIRED_MESSAGE = "Feedback cannot be empty.";
export const FEEDBACK_TOO_LONG_MESSAGE = `Feedback must be ${FEEDBACK_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;

export interface FeedbackValidationResult {
  content: string;
  error: string | null;
}

export interface FeedbackValidationErrorDetails {
  formErrors: string[];
  fieldErrors: {
    content: string[];
  };
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

export function buildFeedbackValidationErrorDetails(message: string): FeedbackValidationErrorDetails {
  return {
    formErrors: [],
    fieldErrors: {
      content: [message],
    },
  };
}

export function parseFeedbackRequest(
  body: unknown,
): { ok: true; content: string } | { ok: false; message: string; details: FeedbackValidationErrorDetails } {
  const content =
    typeof body === "object" && body !== null && "content" in body
      ? (body as { content?: unknown }).content
      : undefined;

  if (typeof content !== "string") {
    return {
      ok: false,
      message: FEEDBACK_REQUIRED_MESSAGE,
      details: buildFeedbackValidationErrorDetails(FEEDBACK_REQUIRED_MESSAGE),
    };
  }

  const validation = validateFeedbackContent(content);
  if (validation.error) {
    return {
      ok: false,
      message: validation.error,
      details: buildFeedbackValidationErrorDetails(validation.error),
    };
  }

  return {
    ok: true,
    content: validation.content,
  };
}

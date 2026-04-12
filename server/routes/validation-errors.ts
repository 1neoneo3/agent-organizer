import type { ZodError, ZodIssue } from "zod";

export interface ValidationErrorResponse {
  error: "validation_error";
  message: string;
  details: {
    formErrors: string[];
    fieldErrors: Record<string, string[] | undefined>;
  };
}

function getIssueField(issue: ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join(".") : "request";
}

function formatIssueMessage(issue: ZodIssue): string {
  const field = getIssueField(issue);

  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? `${field} is required`
        : `${field} has an invalid type`;
    case "too_small":
      if (issue.type === "string" && issue.minimum === 1) {
        return `${field} is required`;
      }
      if (issue.type === "string") {
        return `${field} must be at least ${issue.minimum} characters`;
      }
      return `${field} is too short`;
    case "too_big":
      if (issue.type === "string") {
        return `${field} must be at most ${issue.maximum} characters`;
      }
      return `${field} is too large`;
    case "invalid_enum_value":
      return `${field} must be one of: ${issue.options.join(", ")}`;
    case "invalid_string":
      if (issue.validation === "url") {
        return `${field} must be a valid URL`;
      }
      return `${field} is invalid`;
    default:
      return issue.message || `Invalid value for ${field}`;
  }
}

export function buildValidationErrorResponse(
  resourceName: string,
  error: ZodError,
): ValidationErrorResponse {
  const details = error.flatten((issue) => formatIssueMessage(issue));
  const summaryParts = [
    ...details.formErrors,
    ...Object.values(details.fieldErrors).flatMap((messages) => messages ?? []),
  ];

  return {
    error: "validation_error",
    message: summaryParts.length > 0
      ? `${resourceName} failed: ${summaryParts.join("; ")}.`
      : `${resourceName} failed.`,
    details,
  };
}

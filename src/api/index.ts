let csrfToken: string | null = null;

interface FlattenedValidationError {
  formErrors?: unknown;
  fieldErrors?: unknown;
}

function extractFlattenedValidationMessage(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const { formErrors, fieldErrors } = candidate as FlattenedValidationError;
  if (Array.isArray(formErrors)) {
    const firstFormError = formErrors.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (firstFormError) {
      return firstFormError;
    }
  }

  if (!fieldErrors || typeof fieldErrors !== "object") {
    return null;
  }

  for (const value of Object.values(fieldErrors)) {
    if (!Array.isArray(value)) {
      continue;
    }
    const firstFieldError = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (firstFieldError) {
      return firstFieldError;
    }
  }

  return null;
}

export function extractApiErrorMessage(body: unknown, status: number, statusText: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }

    const validationMessage =
      extractFlattenedValidationMessage(record.details) ??
      extractFlattenedValidationMessage(record.error);
    if (validationMessage) {
      return validationMessage;
    }

    if (typeof record.error === "string" && record.error.trim().length > 0) {
      return record.error;
    }
  }

  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  // Bootstrap session if no CSRF token
  if (!csrfToken) {
    await bootstrapSession();
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
  };

  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(extractApiErrorMessage(body, res.status, res.statusText));
  }

  return res.json();
}

export async function bootstrapSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/session", { credentials: "include" });
    const data = await res.json();
    csrfToken = data.csrf_token;
    return true;
  } catch {
    return false;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

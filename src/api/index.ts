let csrfToken: string | null = null;

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
    throw new Error(body.error ?? `HTTP ${res.status}`);
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
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

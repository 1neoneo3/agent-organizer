import { type Page, type APIRequestContext } from "@playwright/test";

const AUTH_TOKEN = "e2e-test-token";
const BASE = "http://localhost:8792";

/** Authenticate via API and set session cookie + CSRF token */
export async function authenticate(page: Page) {
  // Set auth cookie directly
  await page.context().addCookies([
    {
      name: "ao_session",
      value: AUTH_TOKEN,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
}

/** Get CSRF token via API using Bearer auth */
export async function getCsrfToken(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/api/auth/session`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const json = await res.json();
  return json.csrf_token;
}

/** Make authenticated API call */
export async function apiCall(
  request: APIRequestContext,
  method: "get" | "post" | "put" | "delete",
  path: string,
  data?: unknown,
) {
  const csrf = await getCsrfToken(request);
  const opts = {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "x-csrf-token": csrf,
    },
    ...(data ? { data } : {}),
  };
  return request[method](`${BASE}/api${path}`, opts);
}

/** Clean up all test data (agents and tasks) */
export async function cleanupTestData(request: APIRequestContext) {
  const csrf = await getCsrfToken(request);
  const headers = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "x-csrf-token": csrf,
  };

  // Delete all tasks
  const tasksRes = await request.get(`${BASE}/api/tasks`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const tasks = await tasksRes.json();
  for (const task of tasks) {
    await request.delete(`${BASE}/api/tasks/${task.id}`, { headers });
  }

  // Delete all agents
  const agentsRes = await request.get(`${BASE}/api/agents`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  const agents = await agentsRes.json();
  for (const agent of agents) {
    await request.delete(`${BASE}/api/agents/${agent.id}`, { headers });
  }
}

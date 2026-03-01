import { defineConfig } from "@playwright/test";

const E2E_PORT = 8792;
const NODE22 = "/home/mk/.nvm/versions/node/v22.22.0/bin/node";
const NPX22 = "/home/mk/.nvm/versions/node/v22.22.0/bin/npx";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: {
    command: `${NPX22} tsx server/index.ts`,
    url: `http://localhost:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 15_000,
    env: {
      SESSION_AUTH_TOKEN: "e2e-test-token",
      DB_PATH: "data/e2e-test.db",
      PORT: String(E2E_PORT),
      NODE_ENV: "production",
      PATH: `/home/mk/.nvm/versions/node/v22.22.0/bin:${process.env.PATH}`,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});

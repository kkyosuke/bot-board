import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

function resolveChromiumExecutablePath(): string | undefined {
  if (process.env["CI"] === "true") {
    return undefined;
  }
  const candidates = ["/usr/bin/chromium", "/usr/bin/google-chrome"];
  return candidates.find((candidate) => existsSync(candidate));
}

function resolvePort(): number {
  const raw = process.env["FULLSTACK_PORT"]?.trim();
  if (raw === undefined || raw === "") {
    return 4174;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid FULLSTACK_PORT: "${raw}"`);
  }
  return parsed;
}

const executablePath = resolveChromiumExecutablePath();
const port = resolvePort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/full-stack-mvp.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env["CI"] === "true",
  retries: process.env["CI"] === "true" ? 1 : 0,
  reporter: process.env["CI"] === "true" ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    ...(executablePath !== undefined ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "pc-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "sp-360",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 360, height: 780 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "sp-320",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 320, height: 640 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: `FULLSTACK_TEST_CONTROLS=1 FULLSTACK_USE_LOCAL_ADAPTER=1 FULLSTACK_PORT=${port} bun run tests/e2e/support/fullstack-server.ts`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
